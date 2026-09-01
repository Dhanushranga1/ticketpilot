import base64
import json
import logging
import os
import re
import time
from typing import List, Optional

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from supabase import Client, create_client

logger = logging.getLogger(__name__)

# Stale-while-revalidate cache for user org lists (60 s TTL).
# Same pattern as roles.py — DB blip must not 500 /api/auth/context.
_org_list_cache: dict[str, tuple[list, float]] = {}
_ORG_LIST_TTL = 60.0  # seconds

# JWKS cache for ES256 verification (modern Supabase tokens)
_jwks_cache: tuple[list[dict], float] | None = None
_JWKS_TTL = 3600.0  # 1 hour — public keys change rarely

load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env"
    )


def _is_jwt_key(key: str) -> bool:
    """Supabase SDK only accepts JWT-shaped keys (legacy service_role format)."""
    return bool(
        re.match(r"^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*$", key)
    )


def _build_supabase_client(url: str, key: str) -> Client:
    if _is_jwt_key(key):
        return create_client(url, key)
    # New sb_secret_* API keys: not JWT-shaped. The SDK client is only used for
    # non-critical profile metadata lookups — create it with a placeholder JWT
    # so boot never crashes; real key passed via explicit Authorization header.
    from supabase import ClientOptions

    return create_client(
        url,
        "eyJhbGciOiJIUzI1NiJ9.e30.placeholder",
        options=ClientOptions(headers={"Authorization": f"Bearer {key}"}),
    )


# Create Supabase client
supabase: Client = _build_supabase_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


class User(BaseModel):
    id: str
    email: str | None = None
    role: str | None = "customer"


class UserOrganization(BaseModel):
    """Organization info for user context"""

    id: str
    name: str
    slug: str
    your_role: str
    is_default: bool = False
    settings: dict = {}


class AuthContextResponse(BaseModel):
    """Complete authentication context including organizations"""

    user: User
    organizations: List[UserOrganization]
    default_organization_id: Optional[str] = None


router = APIRouter(prefix="/api/auth", tags=["auth"])


def _fetch_jwks() -> list[dict]:
    """Fetch and cache Supabase Auth JWKS public keys for ES256 verification."""
    global _jwks_cache
    now = time.monotonic()
    if _jwks_cache and (now - _jwks_cache[1]) < _JWKS_TTL:
        return _jwks_cache[0]

    try:
        resp = httpx.get(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        keys = data.get("keys", [])
        _jwks_cache = (keys, now)
        logger.info("Fetched %d JWKS keys from Supabase", len(keys))
        return keys
    except Exception as exc:
        logger.warning("JWKS fetch failed: %s — returning stale cache", exc)
        if _jwks_cache:
            return _jwks_cache[0]
        return []


def _build_ec_key(jwk: dict):
    """Build an EC public key from a JWK dict (P-256 curve).
    Works with cryptography < 42.x (no from_uncompressed_point)."""
    x = base64.urlsafe_b64decode(jwk["x"] + "==")
    y = base64.urlsafe_b64decode(jwk["y"] + "==")
    # Uncompressed point format: 0x04 || x || y
    encoded_point = b"\x04" + x + y
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), encoded_point)


def verify_supabase_jwt(token: str) -> dict:
    """Verify Supabase JWT — supports both ES256 (modern) and HS256 (legacy)."""
    # Peek at the algorithm to decide verification method
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "")
        kid = header.get("kid", "")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    try:
        if alg == "ES256":
            # Modern Supabase: ES256 signed, verify with public key from JWKS
            keys = _fetch_jwks()
            matching = [k for k in keys if k.get("kid") == kid]
            if not matching:
                logger.warning("No matching JWKS key for kid=%s", kid)
                raise HTTPException(401, "Invalid or expired token")
            public_key = _build_ec_key(matching[0])
            payload = jwt.decode(
                token,
                public_key,
                algorithms=["ES256"],
                options={"verify_aud": False},
            )
        elif alg == "HS256":
            # Legacy Supabase: HMAC-SHA256, verify with shared secret
            secret_raw = (
                (os.getenv("SUPABASE_JWT_SECRET") or "").strip().strip('"').strip("'")
            )
            if not secret_raw:
                raise HTTPException(
                    500, "Server misconfiguration: SUPABASE_JWT_SECRET not set"
                )
            secret: str | bytes = secret_raw
            try:
                decoded = base64.b64decode(secret_raw)
                if len(decoded) >= 32:
                    secret = decoded
            except Exception:
                pass
            payload = jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
        else:
            logger.warning("Unsupported JWT algorithm: %s", alg)
            raise HTTPException(401, "Invalid or expired token")
    except jwt.ExpiredSignatureError:
        logger.warning("JWT expired")
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("JWT verification failed: %s", e)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if not payload.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid token: missing subject")

    if "supabase" not in payload.get("iss", ""):
        raise HTTPException(status_code=401, detail="Invalid token: wrong issuer")

    return payload


async def get_current_user(request: Request) -> User:
    """Extract and verify user from JWT token, read role from database"""
    auth = request.headers.get("Authorization")
    if not auth or not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token"
        )

    token = auth.split(" ", 1)[1]
    payload = verify_supabase_jwt(token)

    user_id = payload.get("sub")
    email = payload.get("email")

    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # Read role from database using roles helper
    from .roles import get_user_role

    user_role = await get_user_role(user_id)

    return User(id=user_id, email=email, role=user_role)


async def get_db_connection():
    from .db import get_connection

    return await get_connection()


async def get_user_organizations(user_id: str) -> List[UserOrganization]:
    """
    Fetch all organizations the user is a member of, with stale-while-revalidate
    caching. A DB failure serves the cached list rather than raising a 500.
    """
    # Fast path — serve from cache if still fresh
    cached = _org_list_cache.get(user_id)
    if cached and (time.monotonic() - cached[1]) < _ORG_LIST_TTL:
        return cached[0]

    try:
        import uuid as uuid_lib

        conn = await get_db_connection()
        try:
            user_uuid = uuid_lib.UUID(user_id)
            rows = await conn.fetch(
                """
                SELECT
                    o.id,
                    o.name,
                    o.slug,
                    o.settings,
                    om.role as your_role
                FROM app.organizations o
                JOIN app.organization_members om ON o.id = om.organization_id
                WHERE om.user_id = $1 AND o.is_active = true
                ORDER BY o.name ASC
            """,
                user_uuid,
            )
        finally:
            await conn.close()

        orgs = [
            UserOrganization(
                id=str(row["id"]),
                name=row["name"],
                slug=row["slug"],
                your_role=row["your_role"],
                is_default=(i == 0),
                settings=(
                    json.loads(row["settings"])
                    if isinstance(row["settings"], str)
                    else (row["settings"] or {})
                ),
            )
            for i, row in enumerate(rows)
        ]
        _org_list_cache[user_id] = (orgs, time.monotonic())
        return orgs

    except Exception as e:
        # DB blip — serve stale cache rather than 500-ing the user
        if user_id in _org_list_cache:
            stale, _ = _org_list_cache[user_id]
            # Extend TTL so we don't hammer DB on every request while it's down
            _org_list_cache[user_id] = (stale, time.monotonic())
            logger.warning(
                "Serving stale org list for %s due to DB error: %s",
                user_id,
                type(e).__name__,
            )
            return stale
        logger.error(
            "Error fetching organizations for user %s (no cache): %s",
            user_id,
            e,
            exc_info=True,
        )
        raise


async def auto_create_organization_for_new_user(user_id: str, user_email: str) -> str:
    """
    Automatically create a default organization for new users.
    Called when a user has no organizations.

    Returns: organization_id
    """
    import re
    import uuid as uuid_lib

    logger.info("Auto-creating organization for new user: %s", user_email)

    # Generate organization name and slug from email
    org_name = f"{user_email}'s Organization"

    # Generate slug from email (take username part before @)
    username = user_email.split("@")[0]
    slug = username.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    slug = re.sub(r"-+", "-", slug)

    if len(slug) < 3:
        slug = slug + "-org"
    if len(slug) > 50:
        slug = slug[:50].rstrip("-")

    # Ensure slug is unique by appending timestamp if needed
    import time

    base_slug = slug
    attempt = 0

    conn = await get_db_connection()
    try:
        user_uuid = uuid_lib.UUID(user_id)

        # Ensure user exists in user_roles. Self-signing-up users become org owners,
        # so elevate them to 'admin'. If they were already set to something higher
        # (e.g. accepted an invite earlier) DO NOT downgrade them.
        await conn.execute(
            """
            INSERT INTO app.user_roles (user_id, role)
            VALUES ($1, 'admin')
            ON CONFLICT (user_id) DO UPDATE
              SET role = 'admin'
              WHERE app.user_roles.role = 'customer'
        """,
            user_uuid,
        )

        logger.debug("Ensured user %s exists in user_roles as admin", user_id)

        # Check if slug exists, if so add suffix
        while attempt < 10:
            check_slug = f"{base_slug}-{int(time.time())}" if attempt > 0 else slug

            existing = await conn.fetchval(
                "SELECT 1 FROM app.organizations WHERE slug = $1", check_slug
            )

            if not existing:
                slug = check_slug
                break

            attempt += 1

        # Create organization
        org_id = await conn.fetchval(
            """
            INSERT INTO app.organizations (name, slug, is_active, settings)
            VALUES ($1, $2, true, '{}')
            RETURNING id
        """,
            org_name,
            slug,
        )

        if not org_id:
            raise HTTPException(500, "Failed to create default organization")

        # Add user as owner
        await conn.execute(
            """
            INSERT INTO app.organization_members (organization_id, user_id, role)
            VALUES ($1, $2, $3)
        """,
            org_id,
            user_uuid,
            "owner",
        )

        logger.info("Created organisation '%s' for user %s", org_name, user_email)

        return str(org_id)

    except Exception as e:
        logger.error("Failed to auto-create organisation: %s", e)
        raise HTTPException(500, f"Failed to create default organization: {str(e)}")
    finally:
        await conn.close()


@router.get("/context", response_model=AuthContextResponse)
async def get_auth_context(user: User = Depends(get_current_user)):
    """
    Get complete authentication context including user's organizations.
    Called by frontend after login to populate organization selector.

    If user has no organizations, automatically creates a default one.
    """
    try:
        organizations = await get_user_organizations(user.id)

        if not organizations:
            logger.warning(
                "User %s has no organisations — auto-creating default org", user.email
            )

            try:
                await auto_create_organization_for_new_user(
                    user.id, user.email or "user"
                )

                organizations = await get_user_organizations(user.id)

                if not organizations:
                    raise HTTPException(
                        500, "Failed to create default organization for new user"
                    )

                logger.info("Created default organisation for %s", user.email)

            except Exception as e:
                logger.error("Failed to auto-create organisation: %s", e)
                # Frontend will show "no organisation" state — don't blow up the request

        default_org_id = next((org.id for org in organizations if org.is_default), None)

        return AuthContextResponse(
            user=user,
            organizations=organizations,
            default_organization_id=default_org_id,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error in get_auth_context: %s", e, exc_info=True)
        raise HTTPException(500, f"Failed to get auth context: {str(e)}")

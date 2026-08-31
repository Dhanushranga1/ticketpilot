"""
Tests for backend auth (verify_supabase_jwt, get_current_user) and
organization context middleware (route skipping, JWT user-id extraction,
org-id extraction, role validation, dispatch flow).

All tests use mocked DB; no real PostgreSQL required.
"""

from __future__ import annotations

import base64
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException, Request
from starlette.datastructures import Headers

from tests.conftest import (
    TEST_JWT_SECRET,
    TEST_ORG_ID,
    TEST_USER_ID,
    make_expired_jwt,
    make_invalid_sig_jwt,
    make_jwt,
)

from app.auth import User, _build_ec_key, get_current_user, verify_supabase_jwt
from app.org_middleware import (
    OrganizationContextMiddleware,
    check_org_permission,
    require_org_context,
    require_org_role,
)


# ── helpers ───────────────────────────────────────────────────────────────


def _build_request(
    *,
    auth_header: str | None = None,
    org_header: str | None = None,
    query_params: dict | None = None,
    path: str = "/api/tickets",
    method: str = "GET",
) -> Request:
    headers: dict[str, str] = {}
    if auth_header is not None:
        headers["authorization"] = auth_header
    if org_header is not None:
        headers["x-organization-id"] = org_header
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [
            (k.lower().encode(), v.encode()) for k, v in headers.items()
        ],
    }
    return Request(scope)


def _ec_keypair_and_jwk(kid: str = "test-kid"):
    """Generate a P-256 EC private key + a JWK dict for the matching public key."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    # Unpadded big-endian bytes, base64url
    x_b64 = base64.urlsafe_b64encode(
        public_numbers.x.to_bytes(32, "big")
    ).rstrip(b"=").decode()
    y_b64 = base64.urlsafe_b64encode(
        public_numbers.y.to_bytes(32, "big")
    ).rstrip(b"=").decode()
    jwk = {"kty": "EC", "crv": "P-256", "x": x_b64, "y": y_b64, "kid": kid}
    return private_key, jwk


def _sign_es256_token(
    private_key,
    sub: str = TEST_USER_ID,
    kid: str = "test-kid",
    exp_offset: int = 3600,
) -> str:
    payload = {
        "sub": sub,
        "email": "test@ticketpilot.dev",
        "role": "admin",
        "iss": "https://test-project.supabase.co/auth/v1",
        "iat": int(time.time()),
        "exp": int(time.time()) + exp_offset,
        "aud": "authenticated",
    }
    return jwt.encode(
        payload,
        private_key,
        algorithm="ES256",
        headers={"kid": kid},
    )


# ═════════════════════════════════════════════════════════════════════════
# verify_supabase_jwt — HS256
# ═════════════════════════════════════════════════════════════════════════


class TestVerifySupabaseJWTHS256:
    def test_valid_hs256_token_returns_payload(self):
        token = make_jwt()
        payload = verify_supabase_jwt(token)
        assert payload["sub"] == TEST_USER_ID
        assert payload["email"] == "test@ticketpilot.dev"
        assert payload["role"] == "admin"

    def test_expired_token_raises(self):
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt(make_expired_jwt())
        assert exc.value.status_code == 401

    def test_invalid_signature_raises(self):
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt(make_invalid_sig_jwt())
        assert exc.value.status_code == 401

    def test_wrong_algorithm_raises(self):
        """An algorithm the code doesn't recognize (RS256) is rejected."""
        payload = {
            "sub": TEST_USER_ID,
            "iss": "https://test-project.supabase.co/auth/v1",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
        # Build a fake RSA-like key using HS256 bytes so jwt.encode works,
        # but declare a non-HS256/non-ES256 algorithm.
        raw_token = jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")
        # Tamper with the header alg field by rebuilding
        header_b64, payload_b64, sig = raw_token.split(".")
        bad_header = base64.urlsafe_b64encode(
            b'{"alg":"RS256","typ":"JWT"}'
        ).rstrip(b"=").decode()
        bad_token = f"{bad_header}.{payload_b64}.{sig}"
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt(bad_token)
        assert exc.value.status_code == 401

    def test_missing_sub_claim_raises(self):
        payload = {
            "email": "x@y.z",
            "iss": "https://test-project.supabase.co/auth/v1",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt(token)
        assert exc.value.status_code == 401

    def test_wrong_issuer_raises(self):
        payload = {
            "sub": TEST_USER_ID,
            "iss": "https://evil-issuer.example.com",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt(token)
        assert exc.value.status_code == 401

    def test_malformed_token_raises(self):
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt("not-a-jwt")
        assert exc.value.status_code == 401

    def test_empty_string_raises(self):
        with pytest.raises(HTTPException) as exc:
            verify_supabase_jwt("")
        assert exc.value.status_code == 401


# ═════════════════════════════════════════════════════════════════════════
# verify_supabase_jwt — ES256 (modern Supabase)
# ═════════════════════════════════════════════════════════════════════════


class TestVerifySupabaseJWTES256:
    def test_valid_es256_token_returns_payload(self):
        private_key, jwk = _ec_keypair_and_jwk(kid="key-1")
        token = _sign_es256_token(private_key, kid="key-1")

        with patch("app.auth._fetch_jwks", return_value=[jwk]):
            payload = verify_supabase_jwt(token)
        assert payload["sub"] == TEST_USER_ID
        assert payload["iss"].startswith("https://test-project.supabase.co")

    def test_es256_no_matching_jwks_key_raises(self):
        private_key, _jwk = _ec_keypair_and_jwk(kid="key-1")
        token = _sign_es256_token(private_key, kid="key-1")

        # JWKS returns a DIFFERENT kid — no match
        _, other_jwk = _ec_keypair_and_jwk(kid="key-2")
        with patch("app.auth._fetch_jwks", return_value=[other_jwk]):
            with pytest.raises(HTTPException) as exc:
                verify_supabase_jwt(token)
        assert exc.value.status_code == 401


# ═════════════════════════════════════════════════════════════════════════
# get_current_user — FastAPI dependency
# ═════════════════════════════════════════════════════════════════════════


class TestGetCurrentUser:
    @pytest.mark.asyncio
    async def test_missing_authorization_header(self):
        request = _build_request()
        with pytest.raises(HTTPException) as exc:
            await get_current_user(request)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_non_bearer_auth(self):
        request = _build_request(auth_header="Basic abc")
        with pytest.raises(HTTPException) as exc:
            await get_current_user(request)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_valid_token_returns_user_with_db_role(self):
        token = make_jwt(role="rep")
        request = _build_request(auth_header=f"Bearer {token}")

        with patch("app.roles.get_user_role", new_callable=AsyncMock) as mock_role:
            mock_role.return_value = "admin"
            user = await get_current_user(request)

        assert isinstance(user, User)
        assert user.id == TEST_USER_ID
        assert user.role == "admin"

    @pytest.mark.asyncio
    async def test_invalid_token_propagates_401(self):
        request = _build_request(auth_header=f"Bearer {make_invalid_sig_jwt()}")
        with pytest.raises(HTTPException) as exc:
            await get_current_user(request)
        assert exc.value.status_code == 401


# ═════════════════════════════════════════════════════════════════════════
# OrganizationContextMiddleware — route skipping
# ═════════════════════════════════════════════════════════════════════════


class TestOrgMiddlewareRouteSkipping:
    def setup_method(self):
        self.middleware = OrganizationContextMiddleware(app=lambda scope: None)

    def test_exact_match_skip_routes(self):
        for path in (
            "/api/health",
            "/api/docs",
            "/openapi.json",
            "/api/me",
            "/api/auth/login",
            "/api/auth/context",
            "/api/organizations",
        ):
            assert self.middleware._should_skip_route(path) is True

    def test_prefix_match_skips_docs(self):
        assert self.middleware._should_skip_route("/docs/oauth2") is True
        assert self.middleware._should_skip_route("/redoc") is True

    def test_prefix_match_skips_auth(self):
        assert self.middleware._should_skip_route("/api/auth/refresh") is True
        assert self.middleware._should_skip_route("/api/auth/anything") is True

    def test_prefix_match_skips_health(self):
        assert self.middleware._should_skip_route("/api/health/db") is True

    def test_protected_routes_not_skipped(self):
        for path in (
            "/api/tickets",
            "/api/tickets/abc",
            "/api/kb",
            "/api/reports",
            "/api/organizations/abc",  # org_id path param
            "/api/me/profile",  # exact /api/me is skipped, but /api/me/profile is not
        ):
            assert self.middleware._should_skip_route(path) is False


# ═════════════════════════════════════════════════════════════════════════
# OrganizationContextMiddleware — extract user_id from JWT
# ═════════════════════════════════════════════════════════════════════════


class TestOrgMiddlewareExtractUserId:
    def setup_method(self):
        self.middleware = OrganizationContextMiddleware(app=lambda scope: None)

    def test_valid_hs256_token_extracts_sub(self):
        token = make_jwt()
        request = _build_request(auth_header=f"Bearer {token}")
        user_id = self.middleware._extract_user_id_from_token(request)
        assert user_id == TEST_USER_ID

    def test_invalid_signature_returns_none(self):
        request = _build_request(
            auth_header=f"Bearer {make_invalid_sig_jwt()}"
        )
        assert self.middleware._extract_user_id_from_token(request) is None

    def test_missing_authorization_returns_none(self):
        request = _build_request()
        assert self.middleware._extract_user_id_from_token(request) is None

    def test_non_bearer_returns_none(self):
        request = _build_request(auth_header="Basic abc")
        assert self.middleware._extract_user_id_from_token(request) is None

    def test_es256_token_extracts_sub(self):
        private_key, jwk = _ec_keypair_and_jwk(kid="k1")
        token = _sign_es256_token(private_key, kid="k1")
        request = _build_request(auth_header=f"Bearer {token}")

        with patch("app.auth._fetch_jwks", return_value=[jwk]):
            user_id = self.middleware._extract_user_id_from_token(request)
        assert user_id == TEST_USER_ID


# ═════════════════════════════════════════════════════════════════════════
# OrganizationContextMiddleware — extract org_id
# ═════════════════════════════════════════════════════════════════════════


class TestOrgMiddlewareExtractOrgId:
    def setup_method(self):
        self.middleware = OrganizationContextMiddleware(app=lambda scope: None)

    def test_org_id_from_header(self):
        request = _build_request(org_header=TEST_ORG_ID)
        assert self.middleware._extract_org_id(request) == TEST_ORG_ID

    def test_no_org_id_returns_none(self):
        request = _build_request()
        assert self.middleware._extract_org_id(request) is None

    def test_header_takes_priority_over_query_param(self):
        """Header is the documented primary source."""
        request = _build_request(org_header="header-org")
        assert self.middleware._extract_org_id(request) == "header-org"

    def test_path_params_fallback(self):
        """When org_id lives in path params (e.g. /api/organizations/{org_id})."""
        request = _build_request()
        request.scope["path_params"] = {"org_id": TEST_ORG_ID}
        assert self.middleware._extract_org_id(request) == TEST_ORG_ID


# ═════════════════════════════════════════════════════════════════════════
# OrganizationContextMiddleware — dispatch flow (async)
# ═════════════════════════════════════════════════════════════════════════


class TestOrgMiddlewareDispatch:
    def _make_middleware(self):
        captured: dict = {}

        async def call_next(request: Request):
            captured["org_id"] = getattr(request.state, "org_id", None)
            captured["role"] = getattr(request.state, "user_role_in_org", None)
            return "response"

        return OrganizationContextMiddleware(call_next), captured, call_next

    @pytest.mark.asyncio
    async def test_skipped_route_bypasses_validation(self):
        middleware, captured, call_next = self._make_middleware()
        request = _build_request(
            auth_header=f"Bearer {make_jwt()}",
            org_header=TEST_ORG_ID,
            path="/api/health",
        )
        await middleware.dispatch(request, call_next)
        # Skip path: org_id stays None even though header was provided
        assert captured["org_id"] is None

    @pytest.mark.asyncio
    async def test_no_org_id_bypasses_validation(self):
        middleware, captured, call_next = self._make_middleware()
        request = _build_request(
            auth_header=f"Bearer {make_jwt()}",
            path="/api/tickets",
        )
        await middleware.dispatch(request, call_next)
        assert captured["org_id"] is None

    @pytest.mark.asyncio
    async def test_valid_membership_sets_role(self):
        middleware, captured, call_next = self._make_middleware()
        token = make_jwt()
        request = _build_request(
            auth_header=f"Bearer {token}",
            org_header=TEST_ORG_ID,
            path="/api/tickets",
        )

        with patch.object(
            middleware,
            "_get_user_role_in_org",
            new_callable=AsyncMock,
            return_value="admin",
        ):
            await middleware.dispatch(request, call_next)

        assert captured["org_id"] == TEST_ORG_ID
        assert captured["role"] == "admin"

    @pytest.mark.asyncio
    async def test_non_member_raises_403(self):
        middleware, _, call_next = self._make_middleware()
        request = _build_request(
            auth_header=f"Bearer {make_jwt()}",
            org_header=TEST_ORG_ID,
            path="/api/tickets",
        )

        with patch.object(
            middleware,
            "_get_user_role_in_org",
            new_callable=AsyncMock,
            return_value=None,
        ):
            with pytest.raises(HTTPException) as exc:
                await middleware.dispatch(request, call_next)
        assert exc.value.status_code == 403


# ═════════════════════════════════════════════════════════════════════════
# _get_user_role_in_org — caching + DB error behavior
# ═════════════════════════════════════════════════════════════════════════


class TestGetUserRoleInOrg:
    def setup_method(self):
        self.middleware = OrganizationContextMiddleware(app=lambda scope: None)
        # Clear the module-level cache between tests
        from app.org_middleware import _org_cache

        _org_cache.clear()

    @pytest.mark.asyncio
    async def test_db_returns_role(self):
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"role": "rep"})
        mock_conn.close = AsyncMock()

        with patch("app.db.get_connection", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_conn
            role = await self.middleware._get_user_role_in_org(
                TEST_USER_ID, TEST_ORG_ID
            )
        assert role == "rep"

    @pytest.mark.asyncio
    async def test_non_member_returns_none(self):
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_conn.close = AsyncMock()

        with patch("app.db.get_connection", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_conn
            role = await self.middleware._get_user_role_in_org(
                TEST_USER_ID, TEST_ORG_ID
            )
        assert role is None

    @pytest.mark.asyncio
    async def test_cache_hit_within_ttl(self):
        # Pre-populate cache
        from datetime import datetime, timedelta

        from app.org_middleware import _org_cache

        _org_cache[f"{TEST_USER_ID}:{TEST_ORG_ID}"] = (
            "owner",
            datetime.utcnow() + timedelta(seconds=60),
        )

        # DB should NOT be queried
        with patch("app.db.get_connection") as mock_get:
            role = await self.middleware._get_user_role_in_org(
                TEST_USER_ID, TEST_ORG_ID
            )
            mock_get.assert_not_called()
        assert role == "owner"

    @pytest.mark.asyncio
    async def test_db_error_serves_stale_cache(self):
        from datetime import datetime, timedelta

        from app.org_middleware import _org_cache

        _org_cache[f"{TEST_USER_ID}:{TEST_ORG_ID}"] = (
            "rep",
            datetime.utcnow() - timedelta(seconds=1),  # expired
        )

        with patch(
            "app.db.get_connection",
            new_callable=AsyncMock,
            side_effect=RuntimeError("DB down"),
        ):
            role = await self.middleware._get_user_role_in_org(
                TEST_USER_ID, TEST_ORG_ID
            )
        # Stale cache is served rather than raising 403-like error
        assert role == "rep"

    @pytest.mark.asyncio
    async def test_db_error_no_cache_raises(self):
        from app.org_middleware import _org_cache

        _org_cache.clear()
        with patch(
            "app.db.get_connection",
            new_callable=AsyncMock,
            side_effect=RuntimeError("DB down"),
        ):
            with pytest.raises(RuntimeError):
                await self.middleware._get_user_role_in_org(
                    TEST_USER_ID, TEST_ORG_ID
                )


# ═════════════════════════════════════════════════════════════════════════
# Helper functions (require_org_context, require_org_role, check_org_permission)
# ═════════════════════════════════════════════════════════════════════════


class TestOrgHelpers:
    def test_require_org_context_with_org_id(self):
        request = _build_request(org_header=TEST_ORG_ID)
        request.state.org_id = TEST_ORG_ID
        assert require_org_context(request) == TEST_ORG_ID

    def test_require_org_context_without_org_id_raises(self):
        request = _build_request()
        request.state.org_id = None
        with pytest.raises(HTTPException) as exc:
            require_org_context(request)
        assert exc.value.status_code == 400

    def test_require_org_role_valid(self):
        request = _build_request(org_header=TEST_ORG_ID)
        request.state.org_id = TEST_ORG_ID
        request.state.user_role_in_org = "admin"
        assert require_org_role(request, {"admin", "owner"}) == "admin"

    def test_require_org_role_insufficient(self):
        request = _build_request(org_header=TEST_ORG_ID)
        request.state.org_id = TEST_ORG_ID
        request.state.user_role_in_org = "member"
        with pytest.raises(HTTPException) as exc:
            require_org_role(request, {"admin", "owner"})
        assert exc.value.status_code == 403

    def test_require_org_role_missing_org(self):
        request = _build_request()
        request.state.org_id = None
        request.state.user_role_in_org = None
        with pytest.raises(HTTPException) as exc:
            require_org_role(request, {"admin"})
        assert exc.value.status_code == 400

    def test_check_org_permission_valid(self):
        assert check_org_permission("admin", {"admin", "owner"}) is True

    def test_check_org_permission_denied(self):
        assert check_org_permission("member", {"admin", "owner"}) is False

    def test_check_org_permission_none(self):
        assert check_org_permission(None, {"admin"}) is False


# ═════════════════════════════════════════════════════════════════════════
# _build_ec_key (JWK → EC public key helper)
# ═════════════════════════════════════════════════════════════════════════


class TestBuildECKey:
    def test_round_trip_with_generated_jwk(self):
        _, jwk = _ec_keypair_and_jwk()
        public_key = _build_ec_key(jwk)
        # Verify it's a usable EC public key
        assert public_key.curve.name == "secp256r1"

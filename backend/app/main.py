import asyncio
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import User, get_current_user
from .error_handlers import register_exception_handlers
from .logging_config import get_logger, setup_logging
from .middleware import add_request_logging
from .org_middleware import add_organization_context

# Import security features
try:
    from slowapi.errors import RateLimitExceeded

    from .security import (
        SecurityHeadersMiddleware,
        get_cors_config,
        limiter,
        rate_limit_exceeded_handler,
    )

    SECURITY_ENABLED = True
except ImportError:
    # Fallback if slowapi not installed
    SECURITY_ENABLED = False
    print("⚠️  WARNING: slowapi not installed. Rate limiting disabled.")

load_dotenv()

API_VERSION = os.getenv("API_VERSION", "0.1.0")
WEB_ORIGIN = os.getenv("WEB_ORIGIN", "http://localhost:3000")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

# Initialize logging system
setup_logging(
    app_name="ticketpilot",
    log_level=LOG_LEVEL,
    enable_console=True,  # Always enable console for now
    enable_file=ENVIRONMENT != "development",  # Only file logs in production
)

logger = get_logger(__name__)
logger.info(
    "Starting TicketPilot API",
    extra={
        "environment": ENVIRONMENT,
        "version": API_VERSION,
        "security_enabled": SECURITY_ENABLED,
    },
)


_PRIORITY_DEFAULT_HOURS = {1: 168, 2: 72, 3: 48, 4: 24, 5: 12, 6: 6, 7: 7}


async def _overdue_scan():
    """
    Background scan (every 15 min) covering three concerns:
    1. Auto-flag needs_attention based on priority_level + org attention_thresholds
    2. Mark tickets overdue (respects ETR when set) and send first notification
    3. Send repeat overdue reminders + ETR 1-hour-before reminder
    """
    from .db import get_connection
    from .email import (
        send_etr_reminder_email,
        send_overdue_email,
        send_overdue_reminder_email,
    )

    try:
        conn = await get_connection()
    except Exception as exc:
        logger.error("Overdue scan: DB connection failed: %s", exc)
        return
    try:
        orgs = await conn.fetch(
            "SELECT id, settings FROM app.organizations WHERE is_active = true"
        )
        for org in orgs:
            org_id = str(org["id"])
            raw = org["settings"]
            if not raw:
                settings = {}
            elif isinstance(raw, str):
                import json as _json

                settings = _json.loads(raw)
            else:
                settings = dict(raw)
            threshold_h = float(settings.get("overdue_threshold_hours", 48))
            reminder_h = float(settings.get("overdue_reminder_hours", 24))

            # Build attention threshold map from org settings (falls back to defaults)
            raw_thresholds = settings.get("attention_thresholds", {})
            attention_thresholds = {
                lvl: float(raw_thresholds.get(str(lvl), default_h))
                for lvl, default_h in _PRIORITY_DEFAULT_HOURS.items()
            }

            # ── 1. Auto-flag needs_attention by priority_level ─────────────────
            for lvl, hours in attention_thresholds.items():
                await conn.execute(
                    """
                    UPDATE app.tickets
                    SET needs_attention = true
                    WHERE organization_id = $1
                      AND priority_level = $2
                      AND needs_attention = false
                      AND status NOT IN ('resolved', 'closed')
                      AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 > $3
                """,
                    org_id,
                    lvl,
                    hours,
                )

            # ── 2. Mark overdue (ETR-aware, SLA-policy-aware) ─────────────────
            # Fetch per-priority SLA policies for this org (empty if not configured)
            sla_rows = await conn.fetch(
                "SELECT priority_level, resolution_hours FROM app.sla_policies "
                "WHERE organization_id = $1 AND is_active = TRUE",
                org_id,
            )
            sla_map = {
                r["priority_level"]: float(r["resolution_hours"]) for r in sla_rows
            }

            # Tickets without ETR: per-priority SLA hours, fallback to org threshold_h
            for lvl in range(1, 8):
                hours = sla_map.get(lvl, threshold_h)
                await conn.execute(
                    """
                    UPDATE app.tickets
                    SET is_overdue = true
                    WHERE organization_id = $1
                      AND priority_level = $2
                      AND is_overdue = false
                      AND expected_resolve_at IS NULL
                      AND status NOT IN ('resolved', 'closed')
                      AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 > $3
                """,
                    org_id,
                    lvl,
                    hours,
                )

            # Tickets with no priority_level set — use flat org threshold
            await conn.execute(
                """
                UPDATE app.tickets
                SET is_overdue = true
                WHERE organization_id = $1
                  AND priority_level IS NULL
                  AND is_overdue = false
                  AND expected_resolve_at IS NULL
                  AND status NOT IN ('resolved', 'closed')
                  AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 > $2
            """,
                org_id,
                threshold_h,
            )

            # First-response SLA breach: flag needs_attention if no rep reply yet
            for lvl, first_resp_h in {
                r["priority_level"]: float(r["first_response_hours"]) for r in sla_rows
            }.items():
                if first_resp_h <= 0:
                    continue
                await conn.execute(
                    """
                    UPDATE app.tickets
                    SET needs_attention = true
                    WHERE organization_id = $1
                      AND priority_level = $2
                      AND needs_attention = false
                      AND first_response_at IS NULL
                      AND status NOT IN ('resolved', 'closed')
                      AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 > $3
                """,
                    org_id,
                    lvl,
                    first_resp_h,
                )

            # Tickets WITH ETR: overdue only if past their ETR
            await conn.execute(
                """
                UPDATE app.tickets
                SET is_overdue = true
                WHERE organization_id = $1
                  AND is_overdue = false
                  AND expected_resolve_at IS NOT NULL
                  AND expected_resolve_at < NOW()
                  AND status NOT IN ('resolved', 'closed')
            """,
                org_id,
            )

            # ── 3a. First-time overdue notification ────────────────────────────
            newly_overdue = await conn.fetch(
                """
                SELECT t.id, t.title, au.email AS assignee_email,
                       EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS hours_open
                FROM app.tickets t
                LEFT JOIN auth.users au ON au.id = t.assignee_id
                WHERE t.organization_id = $1
                  AND t.is_overdue = true
                  AND t.overdue_notified_at IS NULL
                  AND t.status NOT IN ('resolved', 'closed')
            """,
                org_id,
            )

            for row in newly_overdue:
                tid = str(row["id"])
                if row["assignee_email"]:
                    send_overdue_email(
                        row["assignee_email"], tid, row["title"], int(row["hours_open"])
                    )
                await conn.execute(
                    "UPDATE app.tickets SET overdue_notified_at = NOW() WHERE id = $1",
                    row["id"],
                )

            # ── 3b. Repeat overdue reminders ───────────────────────────────────
            reminder_due = await conn.fetch(
                """
                SELECT t.id, t.title, au.email AS assignee_email,
                       EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS hours_open
                FROM app.tickets t
                LEFT JOIN auth.users au ON au.id = t.assignee_id
                WHERE t.organization_id = $1
                  AND t.is_overdue = true
                  AND t.overdue_notified_at IS NOT NULL
                  AND EXTRACT(EPOCH FROM (NOW() - t.overdue_notified_at)) / 3600 > $2
                  AND t.status NOT IN ('resolved', 'closed')
            """,
                org_id,
                reminder_h,
            )

            for row in reminder_due:
                tid = str(row["id"])
                if row["assignee_email"]:
                    send_overdue_reminder_email(
                        row["assignee_email"], tid, row["title"], int(row["hours_open"])
                    )
                await conn.execute(
                    "UPDATE app.tickets SET overdue_notified_at = NOW() WHERE id = $1",
                    row["id"],
                )

            # ── 3c. ETR 1-hour-before reminders ───────────────────────────────
            etr_due = await conn.fetch(
                """
                SELECT t.id, t.title, t.expected_resolve_at, au.email AS assignee_email
                FROM app.tickets t
                LEFT JOIN auth.users au ON au.id = t.assignee_id
                WHERE t.organization_id = $1
                  AND t.expected_resolve_at IS NOT NULL
                  AND t.etr_reminder_sent = false
                  AND t.expected_resolve_at BETWEEN NOW() AND NOW() + INTERVAL '1 hour'
                  AND t.status NOT IN ('resolved', 'closed')
            """,
                org_id,
            )

            for row in etr_due:
                tid = str(row["id"])
                etr_str = row["expected_resolve_at"].strftime("%Y-%m-%d %H:%M UTC")
                if row["assignee_email"]:
                    send_etr_reminder_email(
                        row["assignee_email"], tid, row["title"], etr_str
                    )
                await conn.execute(
                    "UPDATE app.tickets SET etr_reminder_sent = true WHERE id = $1",
                    row["id"],
                )
    finally:
        await conn.close()


async def _overdue_task():
    """Background loop: run overdue scan every 15 minutes."""
    while True:
        await asyncio.sleep(15 * 60)
        try:
            await _overdue_scan()
            logger.debug("Overdue scan complete")
        except Exception as exc:
            logger.error("Overdue background task error: %s", exc)


async def _pool_keepalive():
    """
    Keep the asyncpg pool alive and healthy.

    Fires every 4 minutes (well within Supabase's ~10-min idle timeout).
    Also tries to reinitialise the pool if startup failed — this self-heals
    the common case where Render cold-starts while Supabase is still waking up.
    """
    from .db import get_connection, reinit_pool_if_needed

    while True:
        await asyncio.sleep(4 * 60)
        try:
            await reinit_pool_if_needed()
            conn = await get_connection()
            try:
                await conn.fetchval("SELECT 1")
            finally:
                await conn.close()
            logger.debug("[keepalive] pool ping OK")
        except Exception as exc:
            logger.warning("[keepalive] pool ping failed: %s", type(exc).__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from .db import close_pool, init_pool

    await init_pool()

    # Run pending database migrations on every startup.
    # Idempotent — only applies .sql files not yet recorded in app.schema_migrations.
    from .migration_runner import run_migrations

    await run_migrations()

    # ── Safety: guard against dev→prod misconfiguration ───────────────────
    _env = os.getenv("ENVIRONMENT", "development")
    _origin = os.getenv("WEB_ORIGIN", "")
    if _env == "production" and "localhost" in _origin:
        logger.warning(
            "ENVIRONMENT=production but WEB_ORIGIN contains localhost — check config!"
        )
    if _env == "development" and "localhost" not in _origin and _origin:
        logger.warning(
            "ENVIRONMENT=development but WEB_ORIGIN is a remote URL — check config!"
        )

    # pgvector indices live in the database — no cold-start rebuild needed.
    # (FAISS on-disk indices were wiped on every deploy; pgvector persists with the table.)

    task = asyncio.create_task(_overdue_task())
    keepalive = asyncio.create_task(_pool_keepalive())
    yield
    task.cancel()
    keepalive.cancel()
    for t in (task, keepalive):
        try:
            await t
        except asyncio.CancelledError:
            pass
    await close_pool()


app = FastAPI(
    title="TicketPilot API",
    version=API_VERSION,
    lifespan=lifespan,
)

# Add rate limiter state if security is enabled
if SECURITY_ENABLED:
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

# Register global exception handlers
register_exception_handlers(app)

# Add request logging middleware (must be before CORS)
add_request_logging(app)

# Add organization context middleware (after request logging, before CORS)
add_organization_context(app)

# Add security headers middleware if enabled
if SECURITY_ENABLED:
    app.add_middleware(SecurityHeadersMiddleware)

# Get appropriate CORS configuration
cors_config = (
    get_cors_config()
    if SECURITY_ENABLED
    else {
        "allow_origins": [
            WEB_ORIGIN,
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001",
            "http://127.0.0.1:3002",
        ],
        "allow_credentials": True,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
    }
)

app.add_middleware(CORSMiddleware, **cors_config)

from .admin import router as admin_router

# Import and mount routers
from .auth import router as auth_router
from .canned_responses import router as canned_responses_router
from .custom_fields import router as custom_fields_router
from .entitlements_router import router as entitlements_router
from .feedback import router as feedback_router
from .invites import router as invites_router
from .kb import router as kb_router
from .notifications import router as notifications_router
from .organizations import router as organizations_router
from .rep import router as rep_router
from .reports import router as reports_router
from .sla import router as sla_router
from .tickets import router as tickets_router

app.include_router(auth_router)
app.include_router(kb_router)
app.include_router(tickets_router)
app.include_router(rep_router)
app.include_router(admin_router)
app.include_router(feedback_router)
app.include_router(organizations_router)
app.include_router(invites_router)
app.include_router(reports_router)
app.include_router(notifications_router)
app.include_router(sla_router)
app.include_router(canned_responses_router)
app.include_router(custom_fields_router)
app.include_router(entitlements_router)


@app.get("/api/health")
async def health():
    """Health check with DB pool and background task status."""
    import time as _time

    from .db import _pool as _asyncpg_pool

    pool_ok = _asyncpg_pool is not None and not _asyncpg_pool._closed

    return {
        "ok": True,
        "api": "ticketpilot",
        "version": API_VERSION,
        "vector_store": "pgvector",
        "db_pool_connected": pool_ok,
        "timestamp": _time.time(),
    }


@app.get("/api/wake")
async def wake():
    """Pre-warm both DB pools and return latency. Bookmark this for demo cold-starts."""
    import time as _time

    from .db import get_connection, reinit_pool_if_needed
    from .db_sync import _pool as _sync_pool

    result: dict = {"ready": True, "asyncpg": {}, "psycopg3": {}}

    # asyncpg pool
    await reinit_pool_if_needed()
    t0 = _time.monotonic()
    try:
        conn = await get_connection()
        await conn.fetchval("SELECT 1")
        await conn.close()
        result["asyncpg"] = {
            "ok": True,
            "latency_ms": round((_time.monotonic() - t0) * 1000),
        }
    except Exception as exc:
        result["asyncpg"] = {"ok": False, "error": type(exc).__name__}
        result["ready"] = False

    # psycopg3 pool
    t0 = _time.monotonic()
    try:
        from .db_sync import get_db_connection as _sync_conn

        with _sync_conn() as conn:
            conn.execute("SELECT 1")
        result["psycopg3"] = {
            "ok": True,
            "latency_ms": round((_time.monotonic() - t0) * 1000),
        }
    except Exception as exc:
        result["psycopg3"] = {"ok": False, "error": type(exc).__name__}
        result["ready"] = False

    return result


@app.get("/api/health/db")
async def health_db():
    """Diagnose DB connectivity without exposing credentials."""
    import time
    from urllib.parse import urlparse

    import asyncpg

    raw_url = os.getenv("DATABASE_URL", "")
    if not raw_url:
        return {"ok": False, "error": "DATABASE_URL not set"}

    parsed = urlparse(raw_url)
    host = parsed.hostname or "unknown"
    port = parsed.port or 5432
    ssl_mode = "disable" if "pooler.supabase.com" in raw_url else "require"

    result = {
        "host": host,
        "port": port,
        "ssl_mode": ssl_mode,
        "ok": False,
        "latency_ms": None,
        "error": None,
    }

    t0 = time.monotonic()
    try:
        conn = await asyncpg.connect(
            raw_url,
            timeout=10,
            ssl=ssl_mode,
            statement_cache_size=0,
            server_settings={"application_name": "ticketpilot-healthcheck"},
        )
        try:
            await conn.fetchval("SELECT 1")
        finally:
            await conn.close()
        result["ok"] = True
        result["latency_ms"] = round((time.monotonic() - t0) * 1000)
    except Exception as exc:
        result["latency_ms"] = round((time.monotonic() - t0) * 1000)
        result["error"] = type(exc).__name__ + (f": {exc}" if str(exc) else "")

    return result


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return user


# ── User profile (display_name + phone for reps) ──────────────────────────────

from fastapi import Body


@app.get("/api/me/profile")
async def get_my_profile(user: User = Depends(get_current_user)):
    """Return caller's user_metadata (display_name, phone, bio)."""
    from .auth import supabase

    try:
        resp = supabase.auth.admin.get_user_by_id(user.id)
        meta = resp.user.user_metadata or {} if resp.user else {}
    except Exception:
        meta = {}
    return {
        "display_name": meta.get("display_name", ""),
        "phone": meta.get("phone", ""),
        "bio": meta.get("bio", ""),
    }


@app.patch("/api/me/profile")
async def update_my_profile(
    body: dict = Body(...),
    user: User = Depends(get_current_user),
):
    """Update display_name, phone, and/or bio in Supabase user_metadata."""
    from .auth import supabase

    allowed = {k: v for k, v in body.items() if k in ("display_name", "phone", "bio")}
    if not allowed:
        from fastapi import HTTPException

        raise HTTPException(400, "No valid fields provided")
    try:
        resp = supabase.auth.admin.get_user_by_id(user.id)
        existing = resp.user.user_metadata or {} if resp.user else {}
        merged = {**existing, **allowed}
        supabase.auth.admin.update_user_by_id(user.id, {"user_metadata": merged})
    except Exception as exc:
        from fastapi import HTTPException

        raise HTTPException(500, f"Failed to update profile: {exc}")
    return {"ok": True, **allowed}

"""Shared asyncpg connection pool for all async DB operations."""

import asyncio
import logging
import os
import time

import asyncpg

logger = logging.getLogger(__name__)
_pool: asyncpg.Pool | None = None
_circuit_lock = asyncio.Lock()  # guards circuit breaker transitions

# Pool connections run in the background and can afford to wait longer.
# Direct-connect fallback runs inside a live request — fail faster.
_POOL_CONNECT_TIMEOUT = 30
_DIRECT_CONNECT_TIMEOUT = 10
_CONNECT_RETRIES = 3

# ---------------------------------------------------------------------------
# Circuit breaker — prevents a thundering herd when Supabase is unreachable.
#
# After _CIRCUIT_THRESHOLD consecutive total failures, the circuit opens for
# _CIRCUIT_COOLDOWN seconds. All requests during that window raise immediately
# instead of each spawning 3×10s timeout attempts (which hammers Supabase and
# makes recovery slower). After cooldown the circuit half-opens: one attempt
# is allowed through; success resets, failure reopens.
# ---------------------------------------------------------------------------
_CIRCUIT_THRESHOLD = 3  # open after 3 consecutive get_connection() failures
_CIRCUIT_COOLDOWN = 30  # seconds before half-open retry
_consecutive_failures: int = 0
_circuit_open_until: float = 0.0


async def _circuit_check():
    async with _circuit_lock:
        if time.monotonic() < _circuit_open_until:
            raise RuntimeError(
                "DB circuit open — Supabase unreachable; retrying in a moment"
            )


async def _circuit_success():
    global _consecutive_failures, _circuit_open_until
    async with _circuit_lock:
        _consecutive_failures = 0
        _circuit_open_until = 0.0


async def _circuit_failure():
    global _consecutive_failures, _circuit_open_until
    async with _circuit_lock:
        _consecutive_failures += 1
        if _consecutive_failures >= _CIRCUIT_THRESHOLD:
            _circuit_open_until = time.monotonic() + _CIRCUIT_COOLDOWN
            logger.warning(
                "[db] Circuit opened — %d consecutive failures; backing off %ds",
                _consecutive_failures,
                _CIRCUIT_COOLDOWN,
            )


def _ssl_mode(database_url: str) -> str:
    # Supabase requires SSL. Local dev (docker postgres) needs disable/prefer.
    explicit = os.getenv("DB_SSL_MODE", "").strip().lower()
    if explicit in ("require", "prefer", "disable", "allow", "verify-full"):
        return explicit
    return "require"


async def init_pool() -> None:
    global _pool
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        logger.warning("[db] DATABASE_URL not set — asyncpg pool not started")
        return
    db_password = os.getenv("DATABASE_PASSWORD")
    ssl = _ssl_mode(database_url)
    try:
        _pool = await asyncpg.create_pool(
            database_url,
            password=db_password,
            min_size=1,  # keep 1 warm conn — min_size=0 made every idle request pay full connect latency
            max_size=3,
            max_inactive_connection_lifetime=300.0,
            command_timeout=8,
            statement_cache_size=0,
            ssl=ssl,
            timeout=_POOL_CONNECT_TIMEOUT,
            server_settings={
                "application_name": "ticketpilot",
                "statement_timeout": "8000",
            },
        )
        logger.info("[db] asyncpg pool ready (min=0, max=3, ssl=%s)", ssl)
        await _circuit_success()
    except Exception as exc:
        logger.error(
            "[db] Pool init failed: %r — falling back to per-request connections", exc
        )
        _pool = None


async def reinit_pool_if_needed() -> None:
    """Re-create the pool if it is None (startup failed or all connections died)."""
    global _pool
    if _pool is not None:
        return
    logger.info("[db] Pool is None — attempting reinit")
    await init_pool()


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("[db] asyncpg pool closed")


async def get_connection() -> asyncpg.Connection:
    """
    Return a connection from the pool (or a direct connection as fallback).

    Raises RuntimeError immediately when the circuit breaker is open so that
    callers can serve stale cached data rather than waiting 30+ seconds.

    Callers MUST call `await conn.close()` when done.
    """
    await _circuit_check()  # fast-fail when circuit is open

    if _pool is not None:
        try:
            conn = await _pool.acquire(timeout=5)
            await _circuit_success()
            return conn
        except Exception as exc:
            logger.warning(
                "[db] Pool acquire failed (%s) — falling back to direct connect",
                type(exc).__name__,
            )

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL not configured")

    db_password = os.getenv("DATABASE_PASSWORD")
    ssl = _ssl_mode(database_url)
    last_exc: Exception | None = None
    for attempt in range(1, _CONNECT_RETRIES + 1):
        try:
            conn = await asyncpg.connect(
                database_url,
                password=db_password,
                statement_cache_size=0,
                ssl=ssl,
                timeout=_DIRECT_CONNECT_TIMEOUT,
                server_settings={"application_name": "ticketpilot"},
            )
            if attempt > 1:
                logger.info("[db] Direct connect succeeded on attempt %d", attempt)
            await _circuit_success()
            return conn
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "[db] Direct connect attempt %d/%d failed: %s",
                attempt,
                _CONNECT_RETRIES,
                type(exc).__name__,
            )
            if attempt < _CONNECT_RETRIES:
                await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s

    await _circuit_failure()
    raise last_exc  # type: ignore[misc]

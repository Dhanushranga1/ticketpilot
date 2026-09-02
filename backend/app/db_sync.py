"""Shared psycopg3 connection pool for all sync DB operations.

Single pool (max=2) shared across tickets, organizations, kb, observability,
and invites — keeps us under Supabase free-tier connection limits.
"""

import logging
import os

import psycopg
from fastapi import HTTPException
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

DATABASE_URL = os.getenv("DATABASE_URL")
DATABASE_PASSWORD = os.getenv("DATABASE_PASSWORD")
_logger = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def _on_reconnect_failed(pool: ConnectionPool) -> None:
    global _pool
    _logger.warning(
        "[db_sync] Pool gave up reconnecting — falling back to per-request connects"
    )
    _pool = None


def _build_pool() -> ConnectionPool | None:
    if not DATABASE_URL:
        return None
    try:
        pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,  # keep 1 warm conn — cold connects made gated endpoints take seconds
            max_size=2,  # hard cap — Supabase free tier
            max_waiting=10,  # queue requests rather than blow up
            max_idle=300,
            reconnect_timeout=60,
            reconnect_failed=_on_reconnect_failed,
            kwargs={
                "row_factory": dict_row,
                "connect_timeout": 10,
                "options": "-c statement_timeout=8000",
                **({"password": DATABASE_PASSWORD} if DATABASE_PASSWORD else {}),
            },
            open=False,
        )
        pool.open(wait=False)
        _logger.info("[db_sync] psycopg3 pool initialising in background (max=2)")
        return pool
    except Exception as exc:
        _logger.warning(
            "[db_sync] Pool init failed, using per-request fallback: %s", exc
        )
        return None


try:
    _pool = _build_pool()
except Exception:
    _pool = None


def get_db_connection():
    """Return a pooled connection (context manager) or a fresh direct connection."""
    if _pool is not None:
        return _pool.connection()
    if not DATABASE_URL:
        raise HTTPException(500, "DATABASE_URL not configured")
    return psycopg.connect(
        DATABASE_URL,
        password=DATABASE_PASSWORD,
        row_factory=dict_row,
        connect_timeout=10,
        options="-c statement_timeout=8000",
    )

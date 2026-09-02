"""
In-app notification system.
Notifications are per-user (no org header required on read endpoints).
Creation helpers are called from tickets.py / rep.py on key events.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query

from .auth import User, get_current_user
from .db import get_connection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notifications", tags=["notifications"])


# ── Sync helper (called from sync route handlers in threads) ──────────────────


def notify_sync(
    user_id: str,
    notif_type: str,
    title: str,
    body: str,
    ref_type: str = "",
    ref_id: str = "",
    org_id: Optional[str] = None,
) -> None:
    """Insert a notification using the sync psycopg3 pool. Safe to call from threads."""
    try:
        from .db_sync import get_db_connection

        with get_db_connection() as conn:
            conn.cursor().execute(
                """
                INSERT INTO app.notifications
                  (user_id, org_id, type, title, body, ref_type, ref_id)
                VALUES (%s, %s::uuid, %s, %s, %s, %s, %s)
                """,
                (user_id, org_id or None, notif_type, title, body, ref_type, ref_id),
            )
    except Exception as exc:
        logger.debug("notify_sync swallowed: %s", exc)


# ── Async helper (called from async route handlers) ───────────────────────────


async def create_notification(
    user_id: str,
    notif_type: str,
    title: str,
    body: str,
    ref_type: str = "",
    ref_id: str = "",
    org_id: Optional[str] = None,
) -> None:
    """Fire-and-forget: insert one notification row. Silently swallows errors."""
    try:
        conn = await get_connection()
        try:
            await conn.execute(
                """
                INSERT INTO app.notifications
                  (user_id, org_id, type, title, body, ref_type, ref_id)
                VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
                """,
                user_id,
                org_id or None,
                notif_type,
                title,
                body,
                ref_type,
                ref_id,
            )
        finally:
            await conn.close()
    except Exception as exc:
        logger.debug("create_notification swallowed: %s", exc)


# ── API endpoints ─────────────────────────────────────────────────────────────


@router.get("")
async def list_notifications(
    limit: int = Query(default=30, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    """Return the user's latest notifications + unread count."""
    conn = await get_connection()
    try:
        # Single round trip — COUNT(*) FILTER as window fn avoids a second
        # statement (each statement = ~900ms RTT to the Supabase pooler)
        rows = await conn.fetch(
            """
            SELECT id::text, type, title, body, ref_type, ref_id,
                   org_id::text, read_at, created_at,
                   COUNT(*) FILTER (WHERE read_at IS NULL) OVER () AS unread_total
            FROM app.notifications
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user.id,
            limit,
        )
        unread = rows[0]["unread_total"] if rows else 0
        items = [
            {k: v for k, v in dict(r).items() if k != "unread_total"}
            for r in rows
        ]
        return {"unread": int(unread), "items": items}
    except Exception:
        # Table may not exist on older deploys
        return {"unread": 0, "items": []}
    finally:
        await conn.close()


@router.post("/{notif_id}/read")
async def mark_read(notif_id: str, user: User = Depends(get_current_user)):
    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE app.notifications SET read_at=NOW()"
            " WHERE id=$1 AND user_id=$2 AND read_at IS NULL",
            notif_id,
            user.id,
        )
        return {"ok": True}
    finally:
        await conn.close()


@router.post("/read-all")
async def mark_all_read(user: User = Depends(get_current_user)):
    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE app.notifications SET read_at=NOW()"
            " WHERE user_id=$1 AND read_at IS NULL",
            user.id,
        )
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/{notif_id}")
async def delete_notification(notif_id: str, user: User = Depends(get_current_user)):
    conn = await get_connection()
    try:
        await conn.execute(
            "DELETE FROM app.notifications WHERE id=$1 AND user_id=$2",
            notif_id,
            user.id,
        )
        return {"ok": True}
    finally:
        await conn.close()

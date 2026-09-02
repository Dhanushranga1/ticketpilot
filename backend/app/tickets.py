import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from .auth import User, get_current_user
from .db_sync import get_db_connection
from .email import (
    send_ai_failure_email,
    send_customer_reply_email,
    send_new_ticket_email,
    send_rep_reply_email,
    send_ticket_created_for_customer_email,
    send_ticket_resolved_email,
)
from .ai_settings import gen_model
from .observability import get_observer, log_rag_metrics
from .org_middleware import require_org_context
from .entitlements import requires_feature
from .rag_scoring import casper_route, profile_ticket
from .security import limiter
from .schemas import (
    BulkTicketRequest,
    ChatRequest,
    ChatResponse,
    Citation,
    MessageCreate,
    MessageOut,
    RatingRequest,
    ResolutionRequest,
    TagsRequest,
    TicketCreate,
    TicketDetail,
    TicketListResponse,
    TicketSummary,
    TicketWithMessages,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["tickets"])

# Per-org TTL cache for KB chunk counts — avoids an extra DB round-trip on every chat request.
# Keyed by org_id; value is (count, monotonic_timestamp).
_kb_count_cache: Dict[str, Tuple[int, float]] = {}
_KB_COUNT_TTL = 60.0  # seconds


def _get_kb_chunk_count(org_id: str) -> int:
    """Return KB chunk count for org, using a 60-second in-process cache."""
    now = time.monotonic()
    cached = _kb_count_cache.get(org_id)
    if cached and (now - cached[1]) < _KB_COUNT_TTL:
        return cached[0]
    count = 100
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT COUNT(*) AS cnt FROM app.chunks WHERE organization_id = %s",
                (org_id,),
            )
            row = cur.fetchone()
            count = int(row["cnt"]) if row else 100
    except Exception:
        pass
    _kb_count_cache[org_id] = (count, now)
    return count


def get_user_role(user_id: str) -> str:
    """Get user role from database, default to 'customer'."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT role FROM app.user_roles WHERE user_id = %s", (user_id,))
        result = cursor.fetchone()
        return result["role"] if result else "customer"


def is_rep(user: User) -> bool:
    """Check if user has rep or admin role (global role, no org context)."""
    actual_role = get_user_role(user.id)
    return actual_role in ("rep", "admin")


def is_rep_in_org(user: User, request: Request) -> bool:
    """Check rep access using org-scoped role when available.

    Uses request.state.user_role_in_org (injected by OrganizationContextMiddleware)
    so a user demoted in an org loses access immediately, and a user invited as rep
    without a global rep role gains access. Falls back to global role when no org
    header is present (e.g. cross-org endpoints).
    """
    org_role = getattr(request.state, "user_role_in_org", None)
    if org_role is not None:
        return org_role in ("rep", "admin", "owner")
    return get_user_role(user.id) in ("rep", "admin")


@router.post(
    "/tickets", response_model=TicketDetail, status_code=status.HTTP_201_CREATED
)
@limiter.limit("20/minute")
def create_ticket(
    payload: TicketCreate, request: Request, user: User = Depends(get_current_user)
):
    """Create a new ticket with initial message."""
    org_id = require_org_context(request)
    user_role = get_user_role(user.id)

    # Map admin to rep for messages (DB constraint only allows: customer, rep, ai, system)
    message_sender_role = "rep" if user_role == "admin" else user_role

    # Rep/Admin can create a ticket on behalf of a customer
    ticket_owner_id = user.id
    ticket_owner_email = user.email
    if payload.customer_email and user_role in ("rep", "admin"):
        with get_db_connection() as lookup_conn:
            lc = lookup_conn.cursor()
            lc.execute(
                "SELECT id, email FROM auth.users WHERE email = %s LIMIT 1",
                (payload.customer_email,),
            )
            customer_row = lc.fetchone()
        if customer_row:
            ticket_owner_id = customer_row["id"]
            ticket_owner_email = customer_row["email"]
        else:
            raise HTTPException(
                status_code=404, detail="Customer email not found in this organisation"
            )

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # 1) Insert ticket
        cursor.execute(
            """
            INSERT INTO app.tickets (created_by, organization_id, title, description, status, priority, message_count, tags)
            VALUES (%s, %s, %s, %s, 'open', %s, 0, %s)
            RETURNING id, created_by, organization_id, assignee_id, title, description, status,
                      message_count, last_message_at, created_at, updated_at,
                      priority, priority_level, needs_attention, is_overdue, tags, expected_resolve_at
        """,
            (
                ticket_owner_id,
                org_id,
                payload.title,
                payload.description,
                payload.priority,
                payload.tags or [],
            ),
        )

        ticket_row = cursor.fetchone()
        ticket_id = ticket_row["id"]

        # 2) Insert initial message
        cursor.execute(
            """
            INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, ticket_id, sender_id, sender_role, body, created_at
        """,
            (
                ticket_id,
                ticket_owner_id,
                message_sender_role,
                org_id,
                payload.description,
            ),
        )

        message_row = cursor.fetchone()

        # 3) Update ticket message_count and last_message_at
        cursor.execute(
            """
            UPDATE app.tickets
            SET message_count = 1, last_message_at = %s, updated_at = %s
            WHERE id = %s
            RETURNING last_message_at
        """,
            (message_row["created_at"], datetime.utcnow(), ticket_id),
        )

        updated_ticket = cursor.fetchone()

        # 4) Apply SLA-policy ETR (falls back to org default) if not already set
        if not ticket_row.get("expected_resolve_at"):
            etr_hours = None
            priority_level = ticket_row.get("priority_level")
            if priority_level:
                cursor.execute(
                    "SELECT resolution_hours FROM app.sla_policies "
                    "WHERE organization_id = %s AND priority_level = %s AND is_active = TRUE",
                    (org_id, priority_level),
                )
                sla_row = cursor.fetchone()
                if sla_row:
                    etr_hours = float(sla_row["resolution_hours"])
            if etr_hours is None:
                cursor.execute(
                    "SELECT settings FROM app.organizations WHERE id = %s", (org_id,)
                )
                org_row = cursor.fetchone()
                if org_row:
                    etr_hours = (org_row.get("settings") or {}).get("default_etr_hours")
            if etr_hours:
                try:
                    cursor.execute(
                        """
                        UPDATE app.tickets
                        SET expected_resolve_at = NOW() + (%s || ' hours')::interval
                        WHERE id = %s
                        RETURNING expected_resolve_at
                    """,
                        (str(float(etr_hours)), ticket_id),
                    )
                    etr_row = cursor.fetchone()
                    if etr_row:
                        ticket_row = dict(ticket_row)
                        ticket_row["expected_resolve_at"] = etr_row[
                            "expected_resolve_at"
                        ]
                except Exception:
                    pass

        # 5) CASPER-driven auto-assignment — always runs, no admin gate needed
        try:
            # Build CASPER profile from title + description
            casper_profile = profile_ticket(payload.title, payload.description or "")

            # Set CASPER-suggested priority_level if the ticket doesn't have one
            if not ticket_row.get("priority_level"):
                cursor.execute(
                    "UPDATE app.tickets SET priority_level = %s WHERE id = %s",
                    (casper_profile.suggested_priority_level, ticket_id),
                )
                ticket_row = dict(ticket_row)
                ticket_row["priority_level"] = casper_profile.suggested_priority_level

            # Fetch all reps/admins with current load for CASPER routing
            cursor.execute(
                """
                SELECT om.user_id::text, au.email, ur.role,
                       COUNT(t.id) FILTER (
                           WHERE t.assignee_id = om.user_id
                             AND t.status IN ('open','in_progress','escalated')
                       ) AS load
                FROM app.organization_members om
                JOIN auth.users au ON au.id = om.user_id
                JOIN app.user_roles ur ON ur.user_id = om.user_id
                LEFT JOIN app.tickets t ON t.organization_id = %s
                WHERE om.organization_id = %s AND ur.role IN ('rep','admin','owner')
                GROUP BY om.user_id, au.email, ur.role
                ORDER BY load ASC, au.email ASC
            """,
                (org_id, org_id),
            )
            reps = cursor.fetchall()

            best = casper_route(casper_profile, [dict(r) for r in reps])
            if best:
                cursor.execute(
                    "UPDATE app.tickets SET assignee_id = %s WHERE id = %s",
                    (best["user_id"], ticket_id),
                )
                routing_note = (
                    f"[system] CASPER assigned to {best['email']} "
                    f"({casper_profile.routing_reason})"
                )
                cursor.execute(
                    """
                    INSERT INTO app.messages
                      (ticket_id, sender_id, sender_role, organization_id, body)
                    VALUES (%s, %s, 'system', %s, %s)
                """,
                    (ticket_id, user.id, org_id, routing_note),
                )
                cursor.execute(
                    "UPDATE app.tickets SET message_count = message_count + 1 WHERE id = %s",
                    (ticket_id,),
                )
                ticket_row = dict(ticket_row)
                ticket_row["assignee_id"] = best["user_id"]
        except Exception:
            pass  # CASPER routing failure never blocks ticket creation

        conn.commit()

        # Audit log (fire-and-forget)
        try:
            from .admin import log_audit_sync
            log_audit_sync(
                "ticket.created", user,
                resource_type="ticket", resource_id=str(ticket_id),
                org_id=org_id,
                metadata={"title": payload.title, "priority": payload.priority},
            )
        except Exception:
            pass

        # Fire email + in-app notifications (background thread — never blocks ticket creation)
        import threading

        from .notifications import notify_sync

        _assignee_id = (
            str(ticket_row["assignee_id"]) if ticket_row.get("assignee_id") else None
        )

        def _notify():
            try:
                with get_db_connection() as nc:
                    nc_cursor = nc.cursor()
                    nc_cursor.execute(
                        """
                        SELECT DISTINCT au.id::text AS uid, au.email
                        FROM app.organization_members om
                        JOIN auth.users au ON au.id = om.user_id
                        WHERE om.organization_id = %s AND om.role IN ('owner', 'admin', 'rep')
                          AND au.email IS NOT NULL
                        LIMIT 10
                    """,
                        (org_id,),
                    )
                    for row in nc_cursor.fetchall():
                        send_new_ticket_email(
                            row["email"],
                            str(ticket_id),
                            payload.title,
                            user.email or "unknown",
                        )
                # In-app: notify assigned rep
                if _assignee_id:
                    notify_sync(
                        _assignee_id,
                        "ticket_assigned",
                        f"New ticket assigned: {payload.title[:60]}",
                        f"Ticket was assigned to you by CASPER auto-routing.",
                        ref_type="ticket",
                        ref_id=str(ticket_id),
                        org_id=org_id,
                    )
            except Exception:
                pass

        def _notify_customer():
            try:
                send_ticket_created_for_customer_email(
                    ticket_owner_email or "",
                    str(ticket_id),
                    payload.title,
                    user.email or "support",
                    payload.priority,
                )
            except Exception:
                pass

        threading.Thread(target=_notify, daemon=True).start()
        # Email the customer only when a rep/admin creates on their behalf
        if (
            payload.customer_email
            and user_role in ("rep", "admin")
            and ticket_owner_email
        ):
            threading.Thread(target=_notify_customer, daemon=True).start()

        return TicketDetail(
            id=str(ticket_row["id"]),
            created_by=str(ticket_row["created_by"]),
            assignee_id=(
                str(ticket_row["assignee_id"]) if ticket_row["assignee_id"] else None
            ),
            title=ticket_row["title"],
            description=ticket_row["description"],
            status=ticket_row["status"],
            priority=ticket_row.get("priority", "normal"),
            priority_level=ticket_row.get("priority_level"),
            needs_attention=ticket_row.get("needs_attention", False),
            is_overdue=ticket_row.get("is_overdue", False),
            tags=ticket_row.get("tags") or [],
            message_count=1,
            last_message_at=updated_ticket["last_message_at"],
            created_at=ticket_row["created_at"],
            expected_resolve_at=ticket_row.get("expected_resolve_at"),
            customer_email=ticket_owner_email,
        )


@router.get("/tickets", response_model=TicketListResponse)
def list_tickets(
    request: Request,
    status_filter: str = Query("open", pattern="^(open|closed|all)$"),
    q: Optional[str] = Query(None, max_length=100),
    mine: Optional[bool] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    """List tickets with filters and pagination."""
    org_id = require_org_context(request)
    user_is_rep = is_rep_in_org(user, request)

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Build WHERE conditions (using t. alias since list query joins)
        where_conditions = ["t.organization_id = %s"]
        params = [org_id]

        if not user_is_rep:
            where_conditions.append("t.created_by = %s")
            params.append(user.id)
        elif mine:
            where_conditions.append("t.assignee_id = %s")
            params.append(user.id)

        if status_filter != "all":
            where_conditions.append("t.status = %s")
            params.append(status_filter)

        if q:
            where_conditions.append("(t.title ILIKE %s OR t.description ILIKE %s)")
            params.extend([f"%{q}%", f"%{q}%"])

        where_clause = "WHERE " + " AND ".join(where_conditions)

        # Get total count
        count_query = f"SELECT COUNT(*) as total FROM app.tickets t {where_clause}"
        cursor.execute(count_query, params)
        total = cursor.fetchone()["total"]

        # Get paginated results
        list_query = f"""
            SELECT t.id, t.title, t.status, t.priority, t.priority_level,
                   t.needs_attention, t.is_overdue, t.message_count,
                   t.last_message_at, t.created_at, t.assignee_id,
                   t.tags, t.organization_id,
                   au.email AS assignee_email,
                   cu.email AS customer_email
            FROM app.tickets t
            LEFT JOIN auth.users au ON au.id = t.assignee_id
            LEFT JOIN auth.users cu ON cu.id = t.created_by
            {where_clause}
            ORDER BY t.last_message_at DESC
            LIMIT %s OFFSET %s
        """
        cursor.execute(list_query, params + [limit, offset])
        tickets = cursor.fetchall()

        # Fix WHERE clause — list_query uses aliases now
        # (already done above with t. prefix; params match org_id / user.id)

        items = [
            TicketSummary(
                id=str(ticket["id"]),
                title=ticket["title"],
                status=ticket["status"],
                priority=ticket.get("priority", "normal"),
                priority_level=ticket.get("priority_level"),
                needs_attention=ticket.get("needs_attention", False),
                is_overdue=ticket.get("is_overdue", False),
                message_count=ticket["message_count"],
                last_message_at=ticket["last_message_at"],
                created_at=ticket["created_at"],
                assignee_id=(
                    str(ticket["assignee_id"]) if ticket.get("assignee_id") else None
                ),
                assignee_email=ticket.get("assignee_email"),
                customer_email=ticket.get("customer_email"),
                tags=ticket.get("tags") or [],
            )
            for ticket in tickets
        ]

        return TicketListResponse(items=items, total=total, offset=offset, limit=limit)


@router.get("/tickets/{ticket_id}", response_model=TicketWithMessages)
def get_ticket(
    ticket_id: str, request: Request, user: User = Depends(get_current_user)
):
    """Get ticket details with messages."""
    org_id = require_org_context(request)
    user_is_rep = is_rep_in_org(user, request)

    with get_db_connection() as conn:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT t.id, t.created_by, t.organization_id, t.assignee_id,
                   t.title, t.description, t.status, t.priority, t.priority_level,
                   t.needs_attention, t.is_overdue, t.message_count,
                   t.last_message_at, t.created_at, t.updated_at,
                   t.escalated_to, t.escalated_at,
                   t.expected_resolve_at, t.resolved_at,
                   t.resolution_note, t.customer_rating,
                   t.tags,
                   au.email AS assignee_email,
                   au.raw_user_meta_data->>'display_name' AS assignee_display_name,
                   au.raw_user_meta_data->>'phone' AS assignee_phone,
                   cu.email AS customer_email,
                   eu.email AS escalated_to_email
            FROM app.tickets t
            LEFT JOIN auth.users au ON au.id = t.assignee_id
            LEFT JOIN auth.users cu ON cu.id = t.created_by
            LEFT JOIN auth.users eu ON eu.id = t.escalated_to
            WHERE t.id = %s AND t.organization_id = %s
        """,
            (ticket_id, org_id),
        )

        ticket_row = cursor.fetchone()
        if not ticket_row:
            raise HTTPException(status_code=404, detail="Ticket not found")

        # Access check — customers only see their own tickets
        if not user_is_rep and str(ticket_row["created_by"]) != user.id:
            raise HTTPException(status_code=403, detail="Access denied")

        # Messages — customers never see internal notes
        internal_filter = "" if user_is_rep else "AND m.is_internal = false"
        cursor.execute(
            f"""
            SELECT m.id, m.ticket_id, m.sender_id, m.sender_role,
                   m.body, m.created_at, m.is_internal, m.meta
            FROM app.messages m
            WHERE m.ticket_id = %s AND m.organization_id = %s {internal_filter}
            ORDER BY m.created_at ASC
        """,
            (ticket_id, org_id),
        )

        message_rows = cursor.fetchall()

        ticket = TicketDetail(
            id=str(ticket_row["id"]),
            created_by=str(ticket_row["created_by"]),
            assignee_id=(
                str(ticket_row["assignee_id"])
                if ticket_row.get("assignee_id")
                else None
            ),
            assignee_email=ticket_row.get("assignee_email"),
            assignee_display_name=ticket_row.get("assignee_display_name"),
            assignee_phone=ticket_row.get("assignee_phone"),
            customer_email=ticket_row.get("customer_email"),
            title=ticket_row["title"],
            description=ticket_row["description"],
            status=ticket_row["status"],
            priority=ticket_row.get("priority", "normal"),
            priority_level=ticket_row.get("priority_level"),
            needs_attention=ticket_row.get("needs_attention", False),
            is_overdue=ticket_row.get("is_overdue", False),
            tags=ticket_row.get("tags") or [],
            message_count=ticket_row["message_count"],
            last_message_at=ticket_row["last_message_at"],
            created_at=ticket_row["created_at"],
            updated_at=ticket_row.get("updated_at"),
            escalated_to=(
                str(ticket_row["escalated_to"])
                if ticket_row.get("escalated_to")
                else None
            ),
            escalated_to_email=ticket_row.get("escalated_to_email"),
            escalated_at=ticket_row.get("escalated_at"),
            expected_resolve_at=ticket_row.get("expected_resolve_at"),
            resolved_at=ticket_row.get("resolved_at"),
            resolution_note=ticket_row.get("resolution_note"),
            customer_rating=ticket_row.get("customer_rating"),
        )

        messages = [
            MessageOut(
                id=str(msg["id"]),
                ticket_id=str(msg["ticket_id"]),
                sender_id=str(msg["sender_id"]),
                sender_role=msg["sender_role"],
                body=msg["body"],
                created_at=msg["created_at"],
                is_internal=msg.get("is_internal", False),
                meta=msg.get("meta"),
            )
            for msg in message_rows
        ]

        return TicketWithMessages(ticket=ticket, messages=messages)


@router.get("/tickets/{ticket_id}/messages", response_model=List[MessageOut])
def get_messages(
    ticket_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    limit: int = Query(10, ge=1, le=100),
    order: str = Query("asc", regex="^(asc|desc)$"),
):
    """Get messages for a ticket."""
    org_id = require_org_context(request)
    user_is_rep = is_rep_in_org(user, request)

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Check ticket exists and access
        cursor.execute(
            """
            SELECT created_by FROM app.tickets WHERE id = %s AND organization_id = %s
        """,
            (ticket_id, org_id),
        )

        ticket_row = cursor.fetchone()
        if not ticket_row:
            raise HTTPException(status_code=404, detail="Ticket not found")

        # Check access
        if not user_is_rep and ticket_row["created_by"] != uuid.UUID(user.id):
            raise HTTPException(status_code=403, detail="Access denied")

        order_clause = "ASC" if order == "asc" else "DESC"
        user_is_rep_msg = is_rep_in_org(user, request)
        internal_filter = "" if user_is_rep_msg else "AND is_internal = false"
        cursor.execute(
            f"""
            SELECT id, ticket_id, sender_id, sender_role, body, created_at, is_internal, meta
            FROM app.messages
            WHERE ticket_id = %s AND organization_id = %s {internal_filter}
            ORDER BY created_at {order_clause}
            LIMIT %s
        """,
            (ticket_id, org_id, limit),
        )

        message_rows = cursor.fetchall()

        return [
            MessageOut(
                id=str(msg["id"]),
                ticket_id=str(msg["ticket_id"]),
                sender_id=str(msg["sender_id"]),
                sender_role=msg["sender_role"],
                body=msg["body"],
                created_at=msg["created_at"],
                is_internal=msg.get("is_internal", False),
                meta=msg.get("meta"),
            )
            for msg in message_rows
        ]


@router.post(
    "/tickets/{ticket_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
def post_message(
    ticket_id: str,
    payload: MessageCreate,
    request: Request,
    user: User = Depends(get_current_user),
):
    """Add a message to a ticket."""
    org_id = require_org_context(request)
    user_is_rep = is_rep_in_org(user, request)
    user_role = get_user_role(user.id)

    # Map admin to rep for messages (DB constraint only allows: customer, rep, ai, system)
    message_sender_role = "rep" if user_role == "admin" else user_role

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Check ticket exists and access
        cursor.execute(
            """
            SELECT id, created_by, message_count, title
            FROM app.tickets WHERE id = %s AND organization_id = %s
        """,
            (ticket_id, org_id),
        )

        ticket_row = cursor.fetchone()
        if not ticket_row:
            raise HTTPException(status_code=404, detail="Ticket not found")

        # Check access
        if not user_is_rep and ticket_row["created_by"] != uuid.UUID(user.id):
            raise HTTPException(status_code=403, detail="Access denied")

        # Internal notes only allowed for reps/admins
        is_internal = bool(payload.is_internal) and user_is_rep

        cursor.execute(
            """
            INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body, is_internal)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, ticket_id, sender_id, sender_role, body, created_at, is_internal
        """,
            (
                ticket_id,
                user.id,
                message_sender_role,
                org_id,
                payload.body,
                is_internal,
            ),
        )

        message_row = cursor.fetchone()

        cursor.execute(
            """
            UPDATE app.tickets
            SET message_count = message_count + 1,
                last_message_at = %s,
                updated_at = %s
            WHERE id = %s
        """,
            (message_row["created_at"], datetime.utcnow(), ticket_id),
        )

        # Record first rep response time (never overwrite once set)
        if user_is_rep and not is_internal:
            cursor.execute(
                "UPDATE app.tickets SET first_response_at = NOW() "
                "WHERE id = %s AND first_response_at IS NULL",
                (ticket_id,),
            )

        conn.commit()

        # Email notifications (fire-and-forget)
        import threading

        ticket_title = ticket_row["title"] if ticket_row else ""
        ticket_id_str = str(ticket_row["id"]) if ticket_row else ticket_id

        from .notifications import notify_sync

        if user_is_rep and not is_internal:
            # Rep replied → email + notify customer
            def _notify_customer():
                try:
                    with get_db_connection() as nc:
                        nc_cur = nc.cursor()
                        nc_cur.execute(
                            "SELECT au.id::text AS uid, au.email FROM app.tickets t JOIN auth.users au ON au.id = t.created_by WHERE t.id = %s",
                            (ticket_id_str,),
                        )
                        row = nc_cur.fetchone()
                        if row and row["email"]:
                            send_rep_reply_email(
                                row["email"],
                                ticket_id_str,
                                ticket_title,
                                payload.body[:200],
                            )
                        if row and row["uid"]:
                            notify_sync(
                                row["uid"],
                                "new_message",
                                f"New reply on: {ticket_title[:55]}",
                                payload.body[:120],
                                ref_type="ticket",
                                ref_id=ticket_id_str,
                            )
                except Exception:
                    pass

            threading.Thread(target=_notify_customer, daemon=True).start()

        elif not user_is_rep and not is_internal:
            # Customer replied → email + notify assigned rep
            def _notify_rep():
                try:
                    with get_db_connection() as nc:
                        nc_cur = nc.cursor()
                        nc_cur.execute(
                            """
                            SELECT au_rep.id::text AS rep_uid, au_rep.email AS rep_email,
                                   au_cust.email AS cust_email, t.organization_id::text AS org_id
                            FROM app.tickets t
                            LEFT JOIN auth.users au_rep ON au_rep.id = t.assignee_id
                            JOIN auth.users au_cust ON au_cust.id = t.created_by
                            WHERE t.id = %s
                        """,
                            (ticket_id_str,),
                        )
                        row = nc_cur.fetchone()
                        if row and row["rep_email"]:
                            send_customer_reply_email(
                                row["rep_email"],
                                ticket_id_str,
                                ticket_title,
                                row["cust_email"] or "customer",
                                payload.body[:200],
                            )
                        if row and row["rep_uid"]:
                            notify_sync(
                                row["rep_uid"],
                                "new_message",
                                f"Customer replied: {ticket_title[:55]}",
                                payload.body[:120],
                                ref_type="ticket",
                                ref_id=ticket_id_str,
                                org_id=row.get("org_id"),
                            )
                except Exception:
                    pass

            threading.Thread(target=_notify_rep, daemon=True).start()

        return MessageOut(
            id=str(message_row["id"]),
            ticket_id=str(message_row["ticket_id"]),
            sender_id=str(message_row["sender_id"]),
            sender_role=message_row["sender_role"],
            body=message_row["body"],
            created_at=message_row["created_at"],
            is_internal=message_row.get("is_internal", False),
        )


# Phase 4: AI Chat endpoint

# Simple in-memory rate limiting
chat_cooldown = {}
CHAT_COOLDOWN_SECONDS = int(os.getenv("CHAT_COOLDOWN_SECONDS", "8"))
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.55"))
CONFIDENCE_MIN_CHUNKS = int(os.getenv("CONFIDENCE_MIN_CHUNKS", "2"))

# Answer cache — key: f"{org_id}:{prompt_hash}" → (payload, monotonic_ts)
_answer_cache: Dict[str, Tuple[dict, float]] = {}
ANSWER_CACHE_TTL = float(os.getenv("ANSWER_CACHE_TTL_SECONDS", "600"))
ANSWER_CACHE_MAX = int(os.getenv("ANSWER_CACHE_MAX_ENTRIES", "500"))


def invalidate_answer_cache(org_id: str) -> None:
    """Drop cached answers for an org (KB changed)."""
    prefix = f"{org_id}:"
    for key in [k for k in _answer_cache if k.startswith(prefix)]:
        _answer_cache.pop(key, None)


@router.post("/tickets/{ticket_id}/ai-kb-draft")
def ai_kb_draft(
    ticket_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    _gate: None = requires_feature("ai_rag"),
):
    """Agent action: draft a KB article from a resolved ticket's conversation."""
    org_id = require_org_context(request)
    if not is_rep_in_org(user, request):
        raise HTTPException(status_code=403, detail="Rep access required")

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT t.id, t.title, t.status, t.description
            FROM app.tickets t
            WHERE t.id = %s AND t.organization_id = %s
        """,
            (ticket_id, org_id),
        )
        ticket_row = cursor.fetchone()
        if not ticket_row:
            raise HTTPException(status_code=404, detail="Ticket not found")

        cursor.execute(
            """
            SELECT sender_role, body, created_at
            FROM app.messages
            WHERE ticket_id = %s AND organization_id = %s AND is_internal = false
            ORDER BY created_at ASC
            LIMIT 50
        """,
            (ticket_id, org_id),
        )
        message_rows = cursor.fetchall()

    conversation_parts = [f"Ticket: {ticket_row['title']}"]
    if ticket_row.get("description"):
        conversation_parts.append(f"Initial description: {ticket_row['description']}")
    for m in message_rows:
        role = m["sender_role"]
        conversation_parts.append(f"{role.upper()}: {m['body']}")
    conversation = "\n\n".join(conversation_parts)

    from .ai import generate_kb_draft

    try:
        title, content = generate_kb_draft(conversation)
    except Exception as e:
        logger.error("KB draft generation failed for ticket %s: %s", ticket_id, e)
        raise HTTPException(status_code=502, detail="AI generation failed")

    return {"ticket_id": ticket_id, "title": title, "content": content}


def fetch_chunks_by_faiss_ids(faiss_ids: List[int], org_id: str) -> List[dict]:
    """Fetch chunk details from database by FAISS IDs."""
    if not faiss_ids:
        return []

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT c.id as chunk_id, c.doc_id, c.text, c.faiss_id, d.title
            FROM app.chunks c
            JOIN app.documents d ON d.id = c.doc_id
            WHERE c.faiss_id = ANY(%s) AND c.organization_id = %s
            ORDER BY c.faiss_id
        """,
            (faiss_ids, org_id),
        )
        return cursor.fetchall()


@router.post("/tickets/{ticket_id}/chat", response_model=ChatResponse)
@limiter.limit("10/minute")
def chat_with_ai(
    ticket_id: str,
    payload: ChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    _gate: None = requires_feature("ai_rag"),
):
    """Generate AI response for a ticket using enhanced RAG with comprehensive observability."""
    org_id = require_org_context(request)

    # Enforce AI query quota (raises 402 if exhausted)
    from .entitlements import increment_ai_query

    increment_ai_query(org_id)

    # Start observability tracking
    observer = get_observer()
    operation_id = observer.start_operation(ticket_id, user.id, "chat", org_id)

    # Import here to avoid circular dependencies
    from .ai import (
        compute_prompt_hash,
        generate_completion,
        generate_structured_completion,
    )
    from .rag import compute_confidence, retrieve, should_escalate
    from .redact import scrub

    # 1) Verify ticket exists and user has access
    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Check ticket access (same rules as viewing ticket)
        if is_rep_in_org(user, request):
            cursor.execute(
                "SELECT id FROM app.tickets WHERE id = %s AND organization_id = %s",
                (ticket_id, org_id),
            )
        else:
            cursor.execute(
                "SELECT id FROM app.tickets WHERE id = %s AND created_by = %s AND organization_id = %s",
                (ticket_id, user.id, org_id),
            )

        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Ticket not found")

    # 2) Rate limiting per ticket
    now = time.time()
    last_chat = chat_cooldown.get(ticket_id, 0)
    if now - last_chat < CHAT_COOLDOWN_SECONDS:
        raise HTTPException(status_code=429, detail="Please wait before asking again")
    chat_cooldown[ticket_id] = now

    # 3) PII scrub the query
    clean_query = scrub(payload.query)
    observer.record_embedding_metrics(clean_query, 0)  # Will update with actual timing

    # 4) Retrieve relevant chunks using pgvector search
    retrieval_start = time.time()
    retrieval_result = retrieve(
        clean_query,
        org_id=org_id,
    )
    retrieval_latency = int((time.time() - retrieval_start) * 1000)

    # Handle new enhanced return format
    if len(retrieval_result) == 6:
        chunks, sources, context, scores, faiss_ids, retrieval_metrics = (
            retrieval_result
        )
    else:
        # Fallback for old format
        chunks, sources, context, scores, faiss_ids = retrieval_result
        retrieval_metrics = {}
        observer.add_warning("Using fallback retrieval format")

    # Record retrieval metrics
    observer.record_retrieval_metrics(
        len(chunks), scores, retrieval_metrics, retrieval_latency
    )

    # 4b) Similar resolved tickets (J.3) — helps for issues solved before
    similar_tickets: list = []
    if chunks:
        try:
            from .rag import search_similar_tickets

            _qvec = None
            # Reuse the query embedding by asking retrieve's caller — cheapest
            # is one extra embed; acceptable (cached by provider at no extra
            # cost compared to expansion batch, but kept lazy to avoid re-embed)
            from .embeddings import embed_texts

            _qvec = embed_texts([clean_query])[0]
            similar_tickets = search_similar_tickets(
                org_id, clean_query, _qvec, k=3
            )
            if similar_tickets:
                _ticket_lines = "\n".join(
                    f"- [{i+1}] Similar past ticket: {t['title']}"
                    for i, t in enumerate(similar_tickets)
                )
                context = (
                    context
                    + "\n\nSIMILAR PAST TICKETS (may indicate known solutions):\n"
                    + _ticket_lines
                )
        except Exception as e:
            logger.warning("Similar-ticket search failed: %s", e)
            similar_tickets = []

    if not chunks:
        # No relevant context found - enhanced escalation handling
        observer.add_warning("No relevant chunks found in knowledge base")

        with get_db_connection() as conn:
            cursor = conn.cursor()

            # Enhanced no-context response with escalation details
            no_context_response = "I don't have enough information in the knowledge base to answer your question. This issue requires human assistance."

            # Record generation metrics for no-context case
            observer.record_generation_metrics(
                response=no_context_response,
                confidence=0.0,
                citations_count=0,
                model=gen_model(),
                latency_ms=0,
                escalation_triggered=True,
            )

            # Comprehensive escalation metadata
            escalation_info = {
                "requires_human": True,
                "uncertainty_level": "critical",
                "complexity_score": 1.0,
                "missing_info": ["no_relevant_context"],
                "triggered_signals": [
                    "no_chunks_retrieved",
                    "insufficient_knowledge_base",
                ],
                "escalation_reason": "No relevant information found in knowledge base",
            }

            cursor.execute(
                """
                INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body, meta)
                VALUES (%s, %s, 'ai', %s, %s, %s)
                RETURNING id, created_at
            """,
                (
                    ticket_id,
                    user.id,
                    org_id,
                    no_context_response,
                    json.dumps(
                        {
                            "citations": [],
                            "confidence": 0.0,
                            "model": gen_model(),
                            "suggest_escalation": True,
                            "escalation_info": escalation_info,
                            "retrieval_metrics": {"no_chunks": 1.0},
                        }
                    ),
                ),
            )

            message_row = cursor.fetchone()
            message_id = str(message_row["id"])

            # Update ticket stats
            cursor.execute(
                """
                UPDATE app.tickets 
                SET message_count = message_count + 1, 
                    last_message_at = %s, 
                    updated_at = %s
                WHERE id = %s
            """,
                (message_row["created_at"], datetime.utcnow(), ticket_id),
            )

            # Auto-flag ticket for no context case
            cursor.execute(
                "SELECT status FROM app.tickets WHERE id = %s AND organization_id = %s",
                (ticket_id, org_id),
            )
            ticket_status = cursor.fetchone()

            if ticket_status and ticket_status["status"] != "closed":
                cursor.execute(
                    """
                    UPDATE app.tickets 
                    SET needs_attention = true 
                    WHERE id = %s AND organization_id = %s
                """,
                    (ticket_id, org_id),
                )

                cursor.execute(
                    """
                    INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body)
                    VALUES (%s, %s, 'system', %s, %s)
                """,
                    (
                        ticket_id,
                        user.id,
                        org_id,
                        "[system] AI escalation: No relevant knowledge base content (confidence 0.00)",
                    ),
                )

                cursor.execute(
                    """
                    UPDATE app.tickets 
                    SET message_count = message_count + 1
                    WHERE id = %s
                """,
                    (ticket_id,),
                )

            conn.commit()

            # Log metrics and return
            metrics = observer.finish_operation()
            if metrics:
                log_rag_metrics(metrics)

            return ChatResponse(
                message_id=message_id,
                content=no_context_response,
                citations=[],
                confidence=0.0,
                suggest_escalation=True,
            )

    # 5) Generate AI response with enhanced structured generation
    generation_start = time.time()

    # Answer cache — identical prompt (context+query) replays the LLM result
    # without a generation call (J.4). Message rows are still persisted fresh.
    prompt_hash = compute_prompt_hash(context, clean_query)
    cache_key = f"{org_id}:{prompt_hash}"
    cached = _answer_cache.get(cache_key)
    if cached and (time.monotonic() - cached[1]) < ANSWER_CACHE_TTL:
        observer.add_warning("answer_cache_hit")
        ai_response = cached[0]["ai_response"]
        confidence_breakdown = cached[0]["confidence_breakdown"]
        base_confidence = cached[0]["base_confidence"]
        latency_ms = 0
    else:
        try:
            # Try structured generation first
            try:
                structured_response, latency_ms = generate_structured_completion(
                    context, clean_query, sources
                )
                ai_response = structured_response.response

                # Extract confidence from structured response
                confidence_breakdown = structured_response.confidence_indicators
                base_confidence = sum(confidence_breakdown.values()) / len(
                    confidence_breakdown
                )

            except Exception as structured_error:
                observer.add_warning(f"Structured generation failed: {structured_error}")
                # Fallback to basic generation
                ai_response, latency_ms = generate_completion(context, clean_query, sources)
                confidence_breakdown = {}
                base_confidence = 0.5  # Neutral confidence for fallback

        except Exception as e:
            observer.add_error(f"AI generation failed: {e}")
            raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

        # Store in cache (bounded LRU-ish: evict oldest on overflow)
        if len(_answer_cache) >= ANSWER_CACHE_MAX:
            oldest_key = min(
                _answer_cache, key=lambda k: _answer_cache[k][1]
            )
            _answer_cache.pop(oldest_key, None)
        _answer_cache[cache_key] = (
            {
                "ai_response": ai_response,
                "confidence_breakdown": confidence_breakdown,
                "base_confidence": base_confidence,
            },
            time.monotonic(),
        )

    generation_latency = int((time.time() - generation_start) * 1000)

    # 6) Enhanced confidence computation with retrieval metrics
    try:
        # Get conversation length for escalation context
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) as count FROM app.messages WHERE ticket_id = %s",
                (ticket_id,),
            )
            conversation_length = cursor.fetchone()["count"] + 1

        # Fetch KB size for CASPER calibration (60-second TTL cache — no extra DB conn per request)
        kb_chunk_count = _get_kb_chunk_count(org_id)

        # Compute CASPER confidence (intent-adaptive + KB-density-calibrated)
        confidence, confidence_components = compute_confidence(
            scores,
            ai_response,
            len(chunks),
            retrieval_metrics,
            query=clean_query,
            kb_chunk_count=kb_chunk_count,
        )

        # Determine escalation with CASPER's adaptive threshold
        should_escalate_flag, escalation_details = should_escalate(
            confidence,
            retrieval_metrics,
            ai_response,
            conversation_length,
            confidence_breakdown=confidence_components,
        )

    except Exception as conf_error:
        observer.add_warning(f"Enhanced confidence computation failed: {conf_error}")
        # Fallback to basic confidence
        confidence = base_confidence
        confidence_components = {"fallback": base_confidence}
        should_escalate_flag = confidence < CONFIDENCE_THRESHOLD
        escalation_details = {"fallback_escalation": should_escalate_flag}

    # Record generation metrics
    import re

    citations_count = len(re.findall(r"\[\d+\]", ai_response))
    observer.record_generation_metrics(
        response=ai_response,
        confidence=confidence,
        citations_count=citations_count,
        model=gen_model(),
        latency_ms=generation_latency,
        escalation_triggered=should_escalate_flag,
    )

    # 7) Build enhanced citations with confidence scores
    citations = []
    for i, chunk in enumerate(chunks):
        # Calculate per-citation confidence if available
        citation_confidence = scores[i] if i < len(scores) else 0.5

        citation = Citation(
            label=sources[i] if i < len(sources) else f"[{i+1}] Unknown",
            doc_id=str(chunk.get("doc_id", "")),
            chunk_id=str(chunk.get("chunk_id", "")),
            faiss_id=chunk.get("faiss_id", -1),
            score=citation_confidence,
        )
        citations.append(citation)

    # 8) Persist enhanced AI message with comprehensive metadata
    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Build comprehensive message metadata
        message_meta = {
            "citations": [c.dict() for c in citations],
            "confidence": confidence,
            "confidence_breakdown": confidence_components,
            "model": gen_model(),
            "suggest_escalation": should_escalate_flag,
            "escalation_details": escalation_details,
            "retrieval_metrics": retrieval_metrics,
            "generation_latency_ms": latency_ms,
            "conversation_length": conversation_length,
            "similar_tickets": similar_tickets,
        }

        cursor.execute(
            """
            INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body, meta)
            VALUES (%s, %s, 'ai', %s, %s, %s)
            RETURNING id, created_at
        """,
            (ticket_id, user.id, org_id, ai_response, json.dumps(message_meta)),
        )

        message_row = cursor.fetchone()
        message_id = str(message_row["id"])

        # Update ticket stats
        cursor.execute(
            """
            UPDATE app.tickets 
            SET message_count = message_count + 1, 
                last_message_at = %s, 
                updated_at = %s
            WHERE id = %s
        """,
            (message_row["created_at"], datetime.utcnow(), ticket_id),
        )

        # Enhanced escalation handling with detailed reasoning
        if should_escalate_flag:
            # Check if ticket is not closed before flagging
            cursor.execute(
                "SELECT status FROM app.tickets WHERE id = %s AND organization_id = %s",
                (ticket_id, org_id),
            )
            ticket_status = cursor.fetchone()

            if ticket_status and ticket_status["status"] != "closed":
                # Set needs_attention flag
                cursor.execute(
                    """
                    UPDATE app.tickets 
                    SET needs_attention = true 
                    WHERE id = %s AND organization_id = %s
                """,
                    (ticket_id, org_id),
                )

                # Enhanced system message with escalation details
                escalation_reason = escalation_details.get(
                    "reasoning", "AI suggested escalation"
                )
                cursor.execute(
                    """
                    INSERT INTO app.messages (ticket_id, sender_id, sender_role, organization_id, body)
                    VALUES (%s, %s, 'system', %s, %s)
                """,
                    (
                        ticket_id,
                        user.id,
                        org_id,
                        f"[system] {escalation_reason} (confidence {confidence:.2f})",
                    ),
                )

                # Update message count again for the system message
                cursor.execute(
                    """
                    UPDATE app.tickets 
                    SET message_count = message_count + 1
                    WHERE id = %s
                """,
                    (ticket_id,),
                )

        # Enhanced ai_runs logging with comprehensive metrics
        try:
            prompt_hash = compute_prompt_hash(context, clean_query)
            cursor.execute(
                """
                INSERT INTO app.ai_runs (
                    ticket_id, user_id, model, prompt_hash, top_k, confidence,
                    suggest_escalation, input_chars, output_chars, latency_ms,
                    organization_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
                (
                    ticket_id,
                    user.id,
                    gen_model(),
                    prompt_hash,
                    len(chunks),
                    confidence,
                    should_escalate_flag,
                    len(payload.query),
                    len(ai_response),
                    latency_ms,
                    org_id,
                ),
            )
        except Exception as e:
            # Don't fail the main request if logging fails
            print(f"Failed to log ai_runs: {e}")

        conn.commit()

    # Complete observability tracking and log metrics
    metrics = observer.finish_operation()
    if metrics:
        log_rag_metrics(metrics)

    # Email the assigned rep if AI suggested escalation or had low confidence
    if should_escalate_flag:
        import threading

        _ticket_id_str = str(ticket_id)
        _confidence = confidence

        def _notify_ai_failure():
            try:
                with get_db_connection() as nc:
                    nc_cursor = nc.cursor()
                    # Fetch ticket title + assigned rep email in one query
                    nc_cursor.execute(
                        """
                        SELECT t.title, au.email AS rep_email
                        FROM app.tickets t
                        LEFT JOIN auth.users au ON au.id = t.assignee_id
                        WHERE t.id = %s
                    """,
                        (_ticket_id_str,),
                    )
                    row = nc_cursor.fetchone()
                    if not row:
                        return
                    title = row["title"]
                    if row["rep_email"]:
                        send_ai_failure_email(
                            row["rep_email"], _ticket_id_str, title, _confidence
                        )
                    else:
                        # No assignee — notify org admins
                        nc_cursor.execute(
                            """
                            SELECT DISTINCT au.email
                            FROM app.tickets t
                            JOIN app.organization_members om ON om.organization_id = t.organization_id
                            JOIN auth.users au ON au.id = om.user_id
                            WHERE t.id = %s AND om.role IN ('owner', 'admin')
                              AND au.email IS NOT NULL
                            LIMIT 5
                        """,
                            (_ticket_id_str,),
                        )
                        for admin in nc_cursor.fetchall():
                            send_ai_failure_email(
                                admin["email"], _ticket_id_str, title, _confidence
                            )
            except Exception:
                pass

        threading.Thread(target=_notify_ai_failure, daemon=True).start()

    return ChatResponse(
        message_id=message_id,
        content=ai_response,
        citations=citations,
        confidence=confidence,
        suggest_escalation=should_escalate_flag,
        similar_tickets=similar_tickets,
    )


# ── Tags ─────────────────────────────────────────────────────────────────────


@router.patch("/tickets/{ticket_id}/tags", response_model=TicketDetail)
def update_tags(
    ticket_id: str,
    payload: TagsRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """Update ticket tags (reps/admins only)."""
    org_id = require_org_context(request)
    if not is_rep_in_org(user, request):
        raise HTTPException(403, "Rep/admin access required")

    # Normalise: lowercase, strip whitespace, deduplicate, max 10
    clean_tags = list(
        dict.fromkeys(t.strip().lower() for t in payload.tags if t.strip())
    )[:10]

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE app.tickets
            SET tags = %s, updated_at = NOW()
            WHERE id = %s AND organization_id = %s
            RETURNING id
        """,
            (clean_tags, ticket_id, org_id),
        )
        if not cursor.fetchone():
            raise HTTPException(404, "Ticket not found")
        conn.commit()

    # Return full ticket detail
    from fastapi import Request as _R

    return get_ticket(ticket_id, request, user)


# ── Resolve (with optional resolution note) ──────────────────────────────────


@router.post("/tickets/{ticket_id}/resolve", response_model=TicketWithMessages)
def resolve_ticket(
    ticket_id: str,
    payload: ResolutionRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """Resolve a ticket with an optional closing note (reps/admins only)."""
    org_id = require_org_context(request)
    if not is_rep_in_org(user, request):
        raise HTTPException(403, "Rep/admin access required")

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE app.tickets
            SET status = %s,
                resolution_note = %s,
                resolved_at = CASE WHEN status NOT IN ('resolved','closed') THEN NOW() ELSE resolved_at END,
                updated_at = NOW()
            WHERE id = %s AND organization_id = %s
            RETURNING id, created_by, title
        """,
            (payload.status, payload.resolution_note, ticket_id, org_id),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(404, "Ticket not found")
        conn.commit()

    # Notify customer (fire-and-forget)
    import threading

    from .notifications import notify_sync

    _tid = str(row["id"])
    _title = row["title"]
    _created_by = str(row["created_by"]) if row.get("created_by") else None
    _note = payload.resolution_note

    # Embed resolved ticket for similar-ticket retrieval (J.3, fire-and-forget)
    def _embed_resolved():
        try:
            with get_db_connection() as ec:
                ec_cur = ec.cursor()
                ec_cur.execute(
                    "SELECT title, description, resolution_note FROM app.tickets WHERE id = %s",
                    (_tid,),
                )
                trow = ec_cur.fetchone()
            if not trow:
                return
            text = " ".join(
                filter(
                    None,
                    [
                        trow.get("title"),
                        trow.get("description"),
                        trow.get("resolution_note"),
                    ],
                )
            )[:4000]
            if not text.strip():
                return
            from .embeddings import embed_texts

            vec = embed_texts([text])[0]
            with get_db_connection() as uc:
                uc_cur = uc.cursor()
                uc_cur.execute(
                    "UPDATE app.tickets SET title_embedding = %s::vector WHERE id = %s",
                    (str(list(vec)), _tid),
                )
                uc.commit()
        except Exception as e:
            logger.warning("Resolved-ticket embedding failed for %s: %s", _tid, e)

    threading.Thread(target=_embed_resolved, daemon=True).start()

    def _notify_resolved():
        try:
            with get_db_connection() as nc:
                nc_cur = nc.cursor()
                nc_cur.execute(
                    "SELECT au.id::text AS uid, au.email FROM app.tickets t JOIN auth.users au ON au.id = t.created_by WHERE t.id = %s",
                    (_tid,),
                )
                r = nc_cur.fetchone()
                if r and r["email"]:
                    send_ticket_resolved_email(r["email"], _tid, _title, _note)
                if r and r["uid"]:
                    notify_sync(
                        r["uid"],
                        "ticket_resolved",
                        f"Your ticket was resolved: {_title[:60]}",
                        _note or "Your support ticket has been resolved.",
                        ref_type="ticket",
                        ref_id=_tid,
                    )
        except Exception:
            pass

    threading.Thread(target=_notify_resolved, daemon=True).start()

    return get_ticket(ticket_id, request, user)


# ── CSAT rating (customer only) ───────────────────────────────────────────────


@router.post("/tickets/{ticket_id}/rating")
def rate_ticket(
    ticket_id: str,
    payload: RatingRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """Submit CSAT rating 1-5 (ticket owner only, ticket must be resolved/closed)."""
    org_id = require_org_context(request)

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT created_by, status FROM app.tickets
            WHERE id = %s AND organization_id = %s
        """,
            (ticket_id, org_id),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(404, "Ticket not found")
        if str(row["created_by"]) != user.id:
            raise HTTPException(403, "Only the ticket owner can rate")
        if row["status"] not in ("resolved", "closed"):
            raise HTTPException(400, "Ticket must be resolved before rating")

        cursor.execute(
            """
            UPDATE app.tickets
            SET customer_rating = %s, customer_rating_comment = %s, updated_at = NOW()
            WHERE id = %s
        """,
            (payload.rating, payload.comment, ticket_id),
        )
        conn.commit()

    return {"ok": True, "rating": payload.rating}


# ── Bulk operations ───────────────────────────────────────────────────────────


@router.post("/tickets/bulk")
def bulk_ticket_action(
    payload: BulkTicketRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """Bulk status change or assignment for reps/admins."""
    org_id = require_org_context(request)
    if not is_rep_in_org(user, request):
        raise HTTPException(403, "Rep/admin access required")

    ids = payload.ticket_ids
    action = payload.action

    with get_db_connection() as conn:
        cursor = conn.cursor()

        if action in ("resolve", "close"):
            new_status = "resolved" if action == "resolve" else "closed"
            cursor.execute(
                f"""
                UPDATE app.tickets
                SET status = %s,
                    resolution_note = COALESCE(%s, resolution_note),
                    resolved_at = CASE WHEN status NOT IN ('resolved','closed') THEN NOW() ELSE resolved_at END,
                    updated_at = NOW()
                WHERE id = ANY(%s::uuid[]) AND organization_id = %s
                RETURNING id
                """,
                (new_status, payload.note, ids, org_id),
            )
        elif action == "reopen":
            cursor.execute(
                """
                UPDATE app.tickets
                SET status = 'open', resolved_at = NULL, updated_at = NOW()
                WHERE id = ANY(%s::uuid[]) AND organization_id = %s
                RETURNING id
                """,
                (ids, org_id),
            )
        elif action == "assign":
            assignee = payload.assignee_id or user.id
            cursor.execute(
                """
                UPDATE app.tickets
                SET assignee_id = %s::uuid, updated_at = NOW()
                WHERE id = ANY(%s::uuid[]) AND organization_id = %s
                RETURNING id
                """,
                (assignee, ids, org_id),
            )
        else:
            raise HTTPException(400, "Unknown action")

        updated = [str(r["id"]) for r in cursor.fetchall()]
        conn.commit()

    return {"ok": True, "updated": len(updated), "ids": updated}

"""
Feedback module for collecting user feedback on AI responses.
Part of Phase 3: Strategic Improvements (SI-2).
"""

import uuid
from datetime import datetime

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from .auth import User, get_current_user
from .db import get_connection
from .org_middleware import require_org_context
from .roles import get_user_role
from .schemas import FeedbackRequest, FeedbackResponse

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
async def ai_status():
    """Public AI status — model names + key presence only. No secrets, no auth."""
    from .ai_settings import embed_api_key, embed_model, gen_api_key, gen_model

    return {
        "gen_model": gen_model(),
        "embed_model": embed_model(),
        "keys_configured": bool(gen_api_key()) and bool(embed_api_key()),
    }


@router.post("/feedback", response_model=FeedbackResponse)
async def submit_feedback(
    request: Request, body: FeedbackRequest, user: User = Depends(get_current_user)
):
    """
    Submit feedback (thumbs up/down) on an AI message.

    - Users can only submit one feedback per message (enforced by UNIQUE constraint)
    - Returns ok=true on success, ok=false if duplicate feedback
    """
    org_id = require_org_context(request)
    conn = await get_connection()
    try:
        # First, verify the message exists and belongs to a ticket the user has access to
        message_check = await conn.fetchrow(
            """
            SELECT m.id, m.ticket_id, t.created_by, t.id as ticket_exists
            FROM app.messages m
            JOIN app.tickets t ON m.ticket_id = t.id
            WHERE m.id = $1 AND m.organization_id = $2 AND t.organization_id = $2
        """,
            uuid.UUID(body.message_id),
            uuid.UUID(org_id),
        )

        if not message_check:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
            )

        # Check if user has access to this ticket (creator, assigned rep, or admin)
        user_role = await get_user_role(user.id)
        is_admin = user_role == "admin"
        is_creator = str(message_check["created_by"]) == user.id

        # Check if user is assigned to this ticket (for reps)
        is_assigned = False
        if user_role in ("rep", "admin"):
            assigned_check = await conn.fetchval(
                """
                SELECT 1 FROM app.tickets 
                WHERE id = $1 AND assignee_id = $2 AND organization_id = $3
            """,
                message_check["ticket_id"],
                uuid.UUID(user.id),
                uuid.UUID(org_id),
            )
            is_assigned = assigned_check is not None

        if not (is_admin or is_creator or is_assigned):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to this ticket",
            )

        # Insert feedback (will fail on duplicate due to UNIQUE constraint)
        try:
            await conn.execute(
                """
                INSERT INTO app.ai_feedback (
                    id, ticket_id, message_id, user_id, feedback_type, organization_id, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7
                )
            """,
                uuid.uuid4(),
                message_check["ticket_id"],
                uuid.UUID(body.message_id),
                uuid.UUID(user.id),
                body.feedback_type,
                uuid.UUID(org_id),
                datetime.utcnow(),
            )

            return FeedbackResponse(ok=True, message="Thank you for your feedback!")

        except asyncpg.exceptions.UniqueViolationError:
            # User already submitted feedback for this message
            return FeedbackResponse(
                ok=False, message="You've already provided feedback on this message"
            )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to submit feedback: {str(e)}",
        )
    finally:
        await conn.close()

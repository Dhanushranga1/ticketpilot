from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Request schema for chat messages"""

    query: str = Field(
        ..., min_length=1, max_length=1000, description="User query text"
    )


class TicketCreate(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=10, max_length=4000)
    tags: Optional[List[str]] = Field(default_factory=list)
    priority: str = Field(default="normal", pattern="^(low|normal|high|urgent)$")
    customer_email: Optional[str] = None


class TicketSummary(BaseModel):
    id: str
    title: str
    status: str
    priority: str
    priority_level: Optional[int] = None
    needs_attention: bool = False
    is_overdue: bool = False
    message_count: int
    last_message_at: datetime
    created_at: datetime
    tags: List[str] = Field(default_factory=list)
    assignee_id: Optional[str] = None
    assignee_email: Optional[str] = None
    customer_email: Optional[str] = None


class TicketDetail(TicketSummary):
    created_by: str
    description: str
    escalated_to: Optional[str] = None
    escalated_to_email: Optional[str] = None
    escalated_at: Optional[datetime] = None
    expected_resolve_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    resolution_note: Optional[str] = None
    customer_rating: Optional[int] = None
    updated_at: Optional[datetime] = None
    assignee_display_name: Optional[str] = None
    assignee_phone: Optional[str] = None


class TicketListResponse(BaseModel):
    items: List[TicketSummary]
    total: int
    offset: int
    limit: int


class MessageCreate(BaseModel):
    body: str = Field(min_length=1, max_length=8000)
    is_internal: bool = False
    sender_role: Optional[str] = None  # allow system/ai override


class MessageOut(BaseModel):
    id: str
    ticket_id: str
    sender_id: str
    sender_role: str
    body: str
    created_at: datetime
    is_internal: bool = False
    meta: Optional[dict] = None


class TicketWithMessages(BaseModel):
    ticket: TicketDetail
    messages: List[MessageOut]


class TagsRequest(BaseModel):
    tags: List[str] = Field(max_length=10)  # max 10 tags


class ResolutionRequest(BaseModel):
    resolution_note: Optional[str] = Field(default=None, max_length=2000)
    status: str = Field(default="resolved", pattern="^(resolved|closed)$")


class RatingRequest(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: Optional[str] = Field(default=None, max_length=500)


# Phase 4: AI Chat schemas
class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)


class Citation(BaseModel):
    label: str
    doc_id: str
    chunk_id: str
    faiss_id: int
    score: Optional[float] = None


class ChatResponse(BaseModel):
    message_id: str
    content: str
    citations: List[Citation]
    confidence: float
    suggest_escalation: bool
    similar_tickets: List[dict] = []


# Phase 5: Rep Console schemas
class QueueItem(BaseModel):
    id: str
    title: str
    status: str
    priority: str
    priority_level: Optional[int] = None
    needs_attention: bool
    assignee_id: Optional[str] = None
    message_count: int
    last_message_at: datetime
    created_at: datetime
    escalated_to_name: Optional[str] = None
    escalated_at: Optional[datetime] = None
    expected_resolve_at: Optional[datetime] = None
    etr_set_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None


class QueueResponse(BaseModel):
    items: List[QueueItem]
    total: int
    offset: int
    limit: int


class QueueCounts(BaseModel):
    needs_attention: int
    open_active: int
    in_progress: int = 0
    escalated: int
    all: int
    resolved_today: int = 0


class EscalateRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=400)
    escalated_to_user_id: Optional[str] = Field(default=None)


class StatusChangeRequest(BaseModel):
    status: str = Field(pattern="^(open|in_progress|resolved|closed|escalated)$")


class AssignRequest(BaseModel):
    assignee_id: Optional[str] = None  # None => assign to caller


class AckAttentionRequest(BaseModel):
    note: Optional[str] = Field(default=None, max_length=200)


class PriorityRequest(BaseModel):
    priority: str = Field(pattern="^(low|normal|high|urgent)$")


class PriorityLevelRequest(BaseModel):
    priority_level: int = Field(ge=1, le=7)


class ETRRequest(BaseModel):
    expected_resolve_at: datetime


class BulkTicketRequest(BaseModel):
    ticket_ids: list[str] = Field(..., min_length=1, max_length=100)
    action: str = Field(pattern="^(resolve|close|reopen|assign)$")
    assignee_id: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=400)


# Phase 3: AI Feedback schemas
class FeedbackRequest(BaseModel):
    message_id: str = Field(..., description="UUID of the AI message")
    feedback_type: Literal["positive", "negative"] = Field(
        ..., description="User feedback on AI response quality"
    )


class FeedbackResponse(BaseModel):
    ok: bool
    message: str


# Phase 5A: Admin Tools and Role Management schemas
Role = Literal["customer", "rep", "admin"]
RoleRequestStatus = Literal["pending", "approved", "denied", "cancelled"]


class UserRoleItem(BaseModel):
    user_id: str
    email: Optional[str] = None
    role: Role
    role_updated_at: Optional[datetime] = None


class SetRoleRequest(BaseModel):
    role: Role


class RoleRequestCreate(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=400)


class RoleRequestItem(BaseModel):
    id: str
    user_id: str
    email: Optional[str] = None
    reason: Optional[str] = None
    status: RoleRequestStatus
    created_at: datetime
    decided_at: Optional[datetime] = None


class DecideRoleRequest(BaseModel):
    decision: Literal["approve", "deny"]


class DiagnosticInfo(BaseModel):
    timestamp: datetime
    database_version: Optional[str] = None
    extensions: List[str]
    schemas: List[str]
    table_counts: dict


# Assignment schemas
class RepWorkloadItem(BaseModel):
    user_id: str
    email: Optional[str] = None
    role: str
    open_tickets: int


class RepWorkloadResponse(BaseModel):
    reps: List[RepWorkloadItem]
    total_unassigned: int


class AutoAssignResponse(BaseModel):
    assigned: int
    skipped: int
    details: List[dict]


# ── SLA policies ──────────────────────────────────────────────────────────────


class SLAPolicyItem(BaseModel):
    priority_level: int = Field(ge=1, le=7)
    first_response_hours: float = Field(ge=0)
    resolution_hours: float = Field(ge=0)


class SLAPolicyUpsert(BaseModel):
    policies: List[SLAPolicyItem]


class SLAPolicyResponse(BaseModel):
    policies: List[SLAPolicyItem]


# ── Canned responses ──────────────────────────────────────────────────────────


class CannedResponseCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=4000)
    tags: Optional[List[str]] = Field(default_factory=list)


class CannedResponseUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    body: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    tags: Optional[List[str]] = None


class CannedResponseOut(BaseModel):
    id: str
    title: str
    body: str
    tags: List[str]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime


# ── Custom ticket fields ──────────────────────────────────────────────────────


class FieldDefCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    label: str = Field(min_length=1, max_length=80)
    field_type: Literal["text", "number", "select", "date", "boolean"]
    options: Optional[List[str]] = None
    is_required: bool = False
    sort_order: int = 0


class FieldDefUpdate(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=80)
    options: Optional[List[str]] = None
    is_required: Optional[bool] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class FieldDefOut(BaseModel):
    id: str
    name: str
    label: str
    field_type: str
    options: Optional[List[str]]
    is_required: bool
    is_active: bool
    sort_order: int
    created_at: datetime


class FieldValueInput(BaseModel):
    field_def_id: str
    value_text: Optional[str] = None
    value_number: Optional[float] = None
    value_date: Optional[str] = None
    value_bool: Optional[bool] = None


class FieldValueUpsert(BaseModel):
    values: List[FieldValueInput]


class TicketFieldEntry(BaseModel):
    field_def: FieldDefOut
    value_text: Optional[str] = None
    value_number: Optional[float] = None
    value_date: Optional[str] = None
    value_bool: Optional[bool] = None

"""
Observability and metrics module for RAG system.
Provides comprehensive logging, monitoring, and debugging capabilities.
"""

import json
import logging
import os
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# Configure logging
logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")

from .db_sync import get_db_connection as _get_db_connection  # noqa: E402


@dataclass
class RAGMetrics:
    """Comprehensive RAG operation metrics"""

    # Request metadata
    ticket_id: str
    user_id: str
    timestamp: datetime
    operation: str  # 'chat', 'retrieval', 'embedding', etc.

    # Timing metrics
    total_latency_ms: int
    org_id: str = ""
    embedding_latency_ms: Optional[int] = None
    retrieval_latency_ms: Optional[int] = None
    generation_latency_ms: Optional[int] = None

    # Retrieval metrics
    query_length: int = 0
    chunks_retrieved: int = 0
    top_score: float = 0.0
    score_variance: float = 0.0
    context_relevance: float = 0.0
    source_diversity: float = 0.0
    information_density: float = 0.0

    # Generation metrics
    response_length: int = 0
    confidence: float = 0.0
    citations_used: int = 0
    escalation_triggered: bool = False
    model_used: str = ""

    # Error tracking
    errors: List[str] = None
    warnings: List[str] = None

    def __post_init__(self):
        if self.errors is None:
            self.errors = []
        if self.warnings is None:
            self.warnings = []


class RAGObserver:
    """Centralized RAG observability and metrics collection"""

    def __init__(self):
        self.current_operation: Optional[RAGMetrics] = None
        self.operation_start_time: Optional[float] = None

    def start_operation(
        self, ticket_id: str, user_id: str, operation: str, org_id: str = ""
    ) -> str:
        """Start tracking a new RAG operation"""
        operation_id = f"{ticket_id}_{operation}_{int(time.time())}"

        self.current_operation = RAGMetrics(
            ticket_id=ticket_id,
            user_id=user_id,
            org_id=org_id,
            timestamp=datetime.utcnow(),
            operation=operation,
            total_latency_ms=0,
        )

        self.operation_start_time = time.time()

        logger.info(f"Started RAG operation: {operation_id}")
        return operation_id

    def record_embedding_metrics(
        self, query: str, latency_ms: int, errors: List[str] = None
    ):
        """Record embedding-specific metrics"""
        if self.current_operation:
            self.current_operation.query_length = len(query)
            self.current_operation.embedding_latency_ms = latency_ms
            if errors:
                self.current_operation.errors.extend(errors)

    def record_retrieval_metrics(
        self,
        chunks_count: int,
        scores: List[float],
        retrieval_metrics: Dict[str, float],
        latency_ms: int,
    ):
        """Record retrieval-specific metrics"""
        if self.current_operation:
            self.current_operation.chunks_retrieved = chunks_count
            self.current_operation.retrieval_latency_ms = latency_ms

            if scores:
                self.current_operation.top_score = max(scores)
                self.current_operation.score_variance = (
                    float(
                        sum((s - sum(scores) / len(scores)) ** 2 for s in scores)
                        / len(scores)
                    )
                    if len(scores) > 1
                    else 0.0
                )

            # Merge retrieval quality metrics
            self.current_operation.context_relevance = retrieval_metrics.get(
                "context_relevance", 0.0
            )
            self.current_operation.source_diversity = retrieval_metrics.get(
                "source_diversity", 0.0
            )
            self.current_operation.information_density = retrieval_metrics.get(
                "information_density", 0.0
            )

    def record_generation_metrics(
        self,
        response: str,
        confidence: float,
        citations_count: int,
        model: str,
        latency_ms: int,
        escalation_triggered: bool = False,
    ):
        """Record generation-specific metrics"""
        if self.current_operation:
            self.current_operation.response_length = len(response)
            self.current_operation.generation_latency_ms = latency_ms
            self.current_operation.confidence = confidence
            self.current_operation.citations_used = citations_count
            self.current_operation.escalation_triggered = escalation_triggered
            self.current_operation.model_used = model

    def add_warning(self, warning: str):
        """Add a warning to current operation"""
        if self.current_operation:
            self.current_operation.warnings.append(warning)
        logger.warning(f"RAG Warning: {warning}")

    def add_error(self, error: str):
        """Add an error to current operation"""
        if self.current_operation:
            self.current_operation.errors.append(error)
        logger.error(f"RAG Error: {error}")

    def finish_operation(self) -> Optional[RAGMetrics]:
        """Finish current operation and return metrics"""
        if self.current_operation and self.operation_start_time:
            self.current_operation.total_latency_ms = int(
                (time.time() - self.operation_start_time) * 1000
            )

            metrics = self.current_operation
            self.current_operation = None
            self.operation_start_time = None

            # Log completion
            logger.info(
                f"Completed RAG operation: {metrics.operation} "
                f"({metrics.total_latency_ms}ms, confidence={metrics.confidence:.2f})"
            )

            return metrics

        return None


def log_rag_metrics(metrics: RAGMetrics):
    """Persist RAG metrics to database for analysis"""
    if not DATABASE_URL:
        logger.warning("DATABASE_URL not configured, skipping metrics logging")
        return

    try:
        with _get_db_connection() as conn:
            with conn.cursor() as cursor:
                # Enhanced ai_runs logging with comprehensive metrics
                cursor.execute(
                    """
                    INSERT INTO app.ai_runs (
                        ticket_id, user_id, organization_id, model, prompt_hash, top_k, confidence,
                        suggest_escalation, input_chars, output_chars, latency_ms,
                        created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                    (
                        metrics.ticket_id,
                        metrics.user_id,
                        metrics.org_id or None,
                        metrics.model_used,
                        "enhanced_rag",  # Placeholder for prompt hash
                        metrics.chunks_retrieved,
                        metrics.confidence,
                        metrics.escalation_triggered,
                        metrics.query_length,
                        metrics.response_length,
                        metrics.total_latency_ms,
                        metrics.timestamp,
                        # Note: meta column removed - DB schema doesn't include it yet
                        # Future: Add meta JSONB column for detailed metrics
                    ),
                )

            conn.commit()
            logger.debug(f"Logged RAG metrics for ticket {metrics.ticket_id}")

    except Exception as e:
        logger.error(f"Failed to log RAG metrics: {e}")


def get_rag_analytics(hours: int = 24) -> Dict[str, Any]:
    """Retrieve RAG system analytics for the specified time period"""
    if not DATABASE_URL:
        return {"error": "DATABASE_URL not configured"}

    try:
        with _get_db_connection() as conn:
            with conn.cursor() as cursor:
                # Calculate time window
                start_time = datetime.utcnow() - timedelta(hours=hours)

                # Get basic statistics
                cursor.execute(
                    """
                    SELECT 
                        COUNT(*) as total_operations,
                        AVG(confidence) as avg_confidence,
                        AVG(latency_ms) as avg_latency_ms,
                        COUNT(CASE WHEN suggest_escalation THEN 1 END) as escalations,
                        AVG(top_k) as avg_chunks_retrieved
                    FROM app.ai_runs 
                    WHERE created_at >= %s
                """,
                    (start_time,),
                )

                stats = cursor.fetchone()

                # Get confidence distribution
                cursor.execute(
                    """
                    SELECT 
                        CASE 
                            WHEN confidence >= 0.8 THEN 'high'
                            WHEN confidence >= 0.6 THEN 'medium'
                            WHEN confidence >= 0.4 THEN 'low'
                            ELSE 'very_low'
                        END as confidence_bracket,
                        COUNT(*) as count
                    FROM app.ai_runs 
                    WHERE created_at >= %s
                    GROUP BY confidence_bracket
                """,
                    (start_time,),
                )

                confidence_dist = {
                    row["confidence_bracket"]: row["count"] for row in cursor.fetchall()
                }

                # Get model performance
                cursor.execute(
                    """
                    SELECT 
                        model,
                        COUNT(*) as usage_count,
                        AVG(confidence) as avg_confidence,
                        AVG(latency_ms) as avg_latency
                    FROM app.ai_runs 
                    WHERE created_at >= %s AND model IS NOT NULL
                    GROUP BY model
                """,
                    (start_time,),
                )

                model_performance = [
                    {
                        "model": row["model"],
                        "usage_count": row["usage_count"],
                        "avg_confidence": (
                            float(row["avg_confidence"])
                            if row["avg_confidence"]
                            else 0.0
                        ),
                        "avg_latency": (
                            float(row["avg_latency"]) if row["avg_latency"] else 0.0
                        ),
                    }
                    for row in cursor.fetchall()
                ]

                # AI feedback (thumbs) — collected from app.ai_feedback
                try:
                    cursor.execute(
                        """
                        SELECT
                            COUNT(*) FILTER (WHERE feedback_type = 'positive') as positive,
                            COUNT(*) FILTER (WHERE feedback_type = 'negative') as negative
                        FROM app.ai_feedback
                        WHERE created_at >= %s
                        """,
                        (start_time,),
                    )
                    fb = cursor.fetchone()
                    fb_pos = int(fb["positive"] or 0)
                    fb_neg = int(fb["negative"] or 0)
                    feedback_stats = {
                        "positive": fb_pos,
                        "negative": fb_neg,
                        "total": fb_pos + fb_neg,
                        "positive_rate": (
                            fb_pos / (fb_pos + fb_neg) if (fb_pos + fb_neg) > 0 else None
                        ),
                    }
                except Exception as fb_err:
                    logger.warning("Feedback stats query failed: %s", fb_err)
                    feedback_stats = {"positive": 0, "negative": 0, "total": 0, "positive_rate": None}

                return {
                    "time_window_hours": hours,
                    "total_operations": stats["total_operations"] if stats else 0,
                    "avg_confidence": (
                        float(stats["avg_confidence"])
                        if stats and stats["avg_confidence"]
                        else 0.0
                    ),
                    "avg_latency_ms": (
                        float(stats["avg_latency_ms"])
                        if stats and stats["avg_latency_ms"]
                        else 0.0
                    ),
                    "escalation_rate": (
                        (stats["escalations"] / stats["total_operations"])
                        if stats and stats["total_operations"] > 0
                        else 0.0
                    ),
                    "avg_chunks_retrieved": (
                        float(stats["avg_chunks_retrieved"])
                        if stats and stats["avg_chunks_retrieved"]
                        else 0.0
                    ),
                    "confidence_distribution": confidence_dist,
                    "model_performance": model_performance,
                    "feedback": feedback_stats,
                }

    except Exception as e:
        logger.error(f"Failed to retrieve RAG analytics: {e}")
        return {"error": str(e)}


# Global observer instance
rag_observer = RAGObserver()


def get_observer() -> RAGObserver:
    """Get the global RAG observer instance"""
    return rag_observer

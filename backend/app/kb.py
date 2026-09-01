import logging
import os
from typing import List, Optional

import psycopg
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import BaseModel

from .auth import User, get_current_user
from .chunker import make_chunks
from .db_sync import get_db_connection
from .embeddings import embed_texts_async
from .entitlements import requires_feature
from .org_middleware import require_org_context
from .security import limiter
from .utils import normalize_text, sha256, sniff_and_read

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/kb", tags=["kb"])

CHUNK_SIZE = int(os.getenv("CHUNK_SIZE_CHARS", "2400"))
OVERLAP = int(os.getenv("CHUNK_OVERLAP_CHARS", "400"))


def require_rep(user: User):
    """Ensure user has rep / admin role."""
    if user.role not in ["rep", "admin"]:
        raise HTTPException(status_code=403, detail="Rep/Admin access required")


class IngestResponse(BaseModel):
    document_id: str
    chunks_ingested: int
    vectors_added: int


@router.post("/ingest", response_model=IngestResponse)
@limiter.limit("10/minute")
async def ingest(
    request: Request,
    user: User = Depends(get_current_user),
    _gate: None = requires_feature("kb"),
    file: UploadFile = File(None),
    raw_text: Optional[str] = Form(None),
    filename: Optional[str] = Form(None),
):
    org_id = require_org_context(request)
    require_rep(user)

    if not file and not raw_text:
        raise HTTPException(400, "Provide a file or raw_text")

    # 1) Read & normalize
    if file:
        raw = await file.read()
        detected_mime, text = sniff_and_read(
            file.content_type or "", file.filename or "", raw
        )
        source = f"upload:{file.filename or 'unknown'}"
        title = file.filename or "Uploaded file"
        size_bytes = len(raw)
    else:
        text = raw_text or ""
        detected_mime = "text/plain"
        source = "raw"
        title = filename or "Raw text input"
        size_bytes = len(text.encode("utf-8"))

    text = normalize_text(text)
    if not text:
        raise HTTPException(400, "No extractable text")

    doc_hash = sha256(text)

    # 2) Database operations
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # Check for duplicate document in this organization
            cur.execute(
                "SELECT id FROM app.documents WHERE doc_hash = %s AND organization_id = %s",
                (doc_hash, org_id),
            )
            existing = cur.fetchone()
            if existing:
                raise HTTPException(status_code=409, detail="Document already ingested")

            # Create document record
            cur.execute(
                """
                INSERT INTO app.documents (title, source, mime_type, size_bytes, doc_hash, created_by, organization_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """,
                (title, source, detected_mime, size_bytes, doc_hash, user.id, org_id),
            )

            document_record = cur.fetchone()
            document_id = str(document_record["id"])

            # 3) Chunking
            chunks = make_chunks(text, CHUNK_SIZE, OVERLAP)
            if not chunks:
                raise HTTPException(400, "Chunking produced 0 chunks")

            # 4) Process chunks with deduplication
            unique_chunks = []
            unique_ids = []

            for i, chunk_text in enumerate(chunks):
                chunk_hash = sha256(chunk_text)

                # Use a savepoint per chunk so a single duplicate does not roll
                # back the entire batch (including the document INSERT).
                cur.execute("SAVEPOINT chunk_sp")
                try:
                    cur.execute(
                        """
                        INSERT INTO app.chunks (doc_id, chunk_index, text, chunk_hash, token_count, organization_id)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        RETURNING id
                    """,
                        (
                            document_record["id"],
                            i,
                            chunk_text,
                            chunk_hash,
                            len(chunk_text.split()),
                            org_id,
                        ),
                    )

                    chunk_record = cur.fetchone()
                    chunk_id = str(chunk_record["id"])
                    unique_chunks.append(chunk_text)
                    unique_ids.append(chunk_id)
                    cur.execute("RELEASE SAVEPOINT chunk_sp")

                except psycopg.IntegrityError:
                    cur.execute("ROLLBACK TO SAVEPOINT chunk_sp")
                    continue

            if not unique_chunks:
                raise HTTPException(400, "All chunks were duplicates")

            # 5) Generate embeddings and store in pgvector column
            _log.info("[kb] starting embed_texts for %d chunks", len(unique_chunks))
            vectors = await embed_texts_async(unique_chunks)
            _log.info("[kb] embed_texts done; writing to pgvector")

            # 6) Update chunks with embedding vectors
            for idx_i, (chunk_id, vec) in enumerate(
                zip(unique_ids, vectors)
            ):
                _log.info("[kb] DB update chunk %d/%d", idx_i + 1, len(unique_ids))
                cur.execute(
                    "UPDATE app.chunks SET embedding_vec = %s::vector, embedding = %s::float4[] WHERE id = %s::uuid",
                    (str(list(vec)), list(vec), chunk_id),
                )

            _log.info("[kb] all updates done; committing")
            conn.commit()
            _log.info("[kb] commit done")

            import asyncio
            from .admin import log_audit
            asyncio.create_task(log_audit(
                "kb.document.uploaded", user,
                resource_type="document", resource_id=str(document_id),
                org_id=org_id,
                metadata={"title": title, "size_bytes": size_bytes, "mime_type": detected_mime},
            ))

            return IngestResponse(
                document_id=document_id,
                chunks_ingested=len(unique_ids),
                vectors_added=len(vectors),
            )


class KBStats(BaseModel):
    documents: int
    chunks: int


class DocumentItem(BaseModel):
    id: str
    title: str
    source_type: str
    chunk_count: int
    created_at: str


@router.get("/documents", response_model=List[DocumentItem])
async def list_documents(request: Request, user: User = Depends(get_current_user)):
    """Get list of knowledge base documents (rep/admin only)."""
    org_id = require_org_context(request)
    require_rep(user)

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            query = """
                SELECT 
                    d.id,
                    d.title,
                    d.mime_type as source_type,
                    d.created_at,
                    COUNT(c.id) as chunk_count
                FROM app.documents d
                LEFT JOIN app.chunks c ON d.id = c.doc_id
                WHERE d.organization_id = %s
                GROUP BY d.id, d.title, d.mime_type, d.created_at
                ORDER BY d.created_at DESC
            """
            cur.execute(query, (org_id,))
            rows = cur.fetchall()

            return [
                DocumentItem(
                    id=str(row["id"]),
                    title=row["title"] or "Untitled",
                    source_type=row["source_type"] or "unknown",
                    chunk_count=row["chunk_count"] or 0,
                    created_at=(
                        row["created_at"].isoformat() if row["created_at"] else ""
                    ),
                )
                for row in rows
            ]


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: str, request: Request, user: User = Depends(get_current_user)
):
    """Delete a KB document and its chunks (rep/admin only)."""
    org_id = require_org_context(request)
    require_rep(user)

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM app.documents
                WHERE id = %s::uuid AND organization_id = %s
                RETURNING id
                """,
                (doc_id, org_id),
            )
            deleted = cur.fetchone()
            conn.commit()

    if not deleted:
        raise HTTPException(404, "Document not found in this organization")

    import asyncio
    from .admin import log_audit

    asyncio.create_task(
        log_audit(
            "kb.document.deleted",
            user,
            resource_type="document",
            resource_id=doc_id,
            org_id=org_id,
        )
    )

    return {"ok": True, "deleted": str(deleted["id"])}


@router.get("/stats", response_model=KBStats)
async def stats(request: Request, user: User = Depends(get_current_user)):
    """Get knowledge base statistics."""
    org_id = require_org_context(request)

    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS count FROM app.documents WHERE organization_id = %s",
                (org_id,),
            )
            row = cur.fetchone()
            doc_count = (
                (row["count"] if isinstance(row, dict) else row[0]) if row else 0
            )

            cur.execute(
                "SELECT COUNT(*) AS count FROM app.chunks WHERE organization_id = %s",
                (org_id,),
            )
            row = cur.fetchone()
            chunk_count = (
                (row["count"] if isinstance(row, dict) else row[0]) if row else 0
            )

        return KBStats(documents=doc_count or 0, chunks=chunk_count or 0)


class SearchResult(BaseModel):
    faiss_id: int
    score: float
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    text_preview: Optional[str] = None


@router.get("/search", response_model=List[SearchResult])
async def search(
    q: str, k: int = 3, request: Request = None, user: User = Depends(get_current_user), _gate: None = requires_feature("kb")
):
    """Search knowledge base for similar content using pgvector."""
    org_id = require_org_context(request)

    query_vector = (await embed_texts_async([q]))[0]

    with get_db_connection() as conn:
        results = []
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.id as chunk_id, c.doc_id, c.text, d.id as document_id,
                       1.0 - (c.embedding_vec <=> %s::vector) as score
                FROM app.chunks c
                JOIN app.documents d ON c.doc_id = d.id
                WHERE c.organization_id = %s
                  AND c.embedding_vec IS NOT NULL
                ORDER BY c.embedding_vec <=> %s::vector
                LIMIT %s
                """,
                (str(query_vector), org_id, str(query_vector), k),
            )

            for row in cur.fetchall():
                preview = (
                    row["text"][:200] + "..."
                    if len(row["text"]) > 200
                    else row["text"]
                )
                results.append(
                    SearchResult(
                        faiss_id=row.get("faiss_id") or 0,
                        score=float(row["score"]),
                        document_id=str(row["document_id"]),
                        chunk_id=str(row["chunk_id"]),
                        text_preview=preview,
                    )
                )

        return results

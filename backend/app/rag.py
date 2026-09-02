"""
RAG retrieval module.
Hybrid retrieval: pgvector cosine + tsvector full-text + pg_trgm fuzzy, fused
with Reciprocal Rank Fusion. MMR re-ranking + CASPER adaptive confidence on top.
"""

import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .ai_settings import embed_dim as _embed_dim
from .embeddings import embed_texts
from .rag_scoring import casper_confidence, classify_query_intent
from .redact import scrub

logger = logging.getLogger(__name__)

EMBEDDING_DIM = _embed_dim()

RRF_K = 60  # reciprocal-rank fusion constant


def _row_to_chunk(row: Dict) -> Dict:
    return {
        "chunk_id": str(row["chunk_id"]),
        "doc_id": str(row["doc_id"]),
        "text": row["text"],
        "faiss_id": row["faiss_id"],
        "title": row["title"],
        "_emb": np.array(row["embedding_array"], dtype=np.float32),
        "score": 0.0,
    }


def _add_ranks(acc: Dict[str, float], ids: List[str]) -> None:
    for rank, chunk_id in enumerate(ids):
        acc[chunk_id] = acc.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank + 1)


def hybrid_search_chunks(
    org_id: str, query: str, query_vector: List[float], k: int = 20
) -> List[Dict]:
    """
    Hybrid retrieval — RRF fusion of:
      1. pgvector cosine (semantic)
      2. tsvector websearch full-text (lexical — acronyms, error codes, product names)
      3. pg_trgm similarity (fuzzy — typo tolerance)

    Returns chunk dicts ranked by fused score; `score` recomputed as cosine
    similarity so downstream MIN_SCORE filtering behaves uniformly.
    Falls back to vector-only search when lexical indexes are unavailable.
    """
    from .db_sync import get_db_connection

    if not org_id or not query:
        return []

    if query_vector:
        return _hybrid_search_with_vectors(org_id, query, query_vector, k)
    return search_chunks_pgvector(org_id, query_vector or [], k)


def _hybrid_search_with_vectors(
    org_id: str, query: str, query_vector: List[float], k: int
) -> List[Dict]:
    from .db_sync import get_db_connection

    rrf: Dict[str, float] = {}
    rows_by_id: Dict[str, Dict] = {}

    _SELECT = """
        SELECT c.id as chunk_id, c.doc_id, c.text, c.faiss_id, d.title,
               c.embedding_vec::float4[] as embedding_array
        FROM app.chunks c
        JOIN app.documents d ON d.id = c.doc_id
        WHERE c.organization_id = %s
    """

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # 1) Semantic
        try:
            cursor.execute(
                _SELECT
                + " AND c.embedding_vec IS NOT NULL"
                + " ORDER BY c.embedding_vec <=> %s::vector LIMIT %s",
                (org_id, str(query_vector), k),
            )
            vec_rows = cursor.fetchall()
            for row in vec_rows:
                rows_by_id[str(row["chunk_id"])] = row
            _add_ranks(rrf, [str(r["chunk_id"]) for r in vec_rows])
        except Exception as e:
            logger.warning("[hybrid] vector search failed: %s", e)

        # 2) Lexical (full-text)
        try:
            cursor.execute(
                _SELECT
                + " AND c.text_search @@ websearch_to_tsquery('english', %s)"
                + " ORDER BY ts_rank(c.text_search, websearch_to_tsquery('english', %s)) DESC"
                + " LIMIT %s",
                (org_id, query, query, k),
            )
            lex_rows = cursor.fetchall()
            for row in lex_rows:
                rows_by_id.setdefault(str(row["chunk_id"]), row)
            _add_ranks(rrf, [str(r["chunk_id"]) for r in lex_rows])
        except Exception as e:
            logger.debug("[hybrid] lexical search skipped: %s", e)

        # 3) Fuzzy (trigram)
        try:
            cursor.execute(
                _SELECT
                + " AND c.text %% %s"
                + " ORDER BY similarity(c.text, %s) DESC LIMIT %s",
                (org_id, query, query, k),
            )
            tri_rows = cursor.fetchall()
            for row in tri_rows:
                rows_by_id.setdefault(str(row["chunk_id"]), row)
            _add_ranks(rrf, [str(r["chunk_id"]) for r in tri_rows])
        except Exception as e:
            logger.debug("[hybrid] trigram search skipped: %s", e)

    if not rrf:
        return []

    ranked_ids = sorted(rrf, key=lambda cid: rrf[cid], reverse=True)[:k]

    # Recompute uniform cosine score from stored embeddings
    q = np.array(query_vector, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    results = []
    for chunk_id in ranked_ids:
        row = rows_by_id[chunk_id]
        chunk = _row_to_chunk(row)
        try:
            emb = chunk["_emb"]
            emb_norm = float(np.linalg.norm(emb))
            if q_norm > 0 and emb_norm > 0:
                chunk["score"] = float(np.dot(emb, q) / (emb_norm * q_norm))
        except Exception:
            chunk["score"] = 0.0
        results.append(chunk)
    return results


def search_chunks_pgvector(
    org_id: str, query_vector: List[float], k: int = 6
) -> List[Dict]:
    """
    Vector-only search (pgvector cosine). Fallback path — prefer
    hybrid_search_chunks(). Falls back to in-memory numpy search if pgvector
    is unavailable.
    """
    from .db_sync import get_db_connection

    if not query_vector or not org_id:
        return []

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT c.id as chunk_id, c.doc_id, c.text, c.faiss_id, d.title,
                       c.embedding_vec::float4[] as embedding_array,
                       1.0 - (c.embedding_vec <=> %s::vector) as score
                FROM app.chunks c
                JOIN app.documents d ON d.id = c.doc_id
                WHERE c.organization_id = %s
                  AND c.embedding_vec IS NOT NULL
                ORDER BY c.embedding_vec <=> %s::vector
                LIMIT %s
                """,
                (str(query_vector), org_id, str(query_vector), k),
            )
            rows = cursor.fetchall()

        results = []
        for row in rows:
            results.append(
                {
                    "chunk_id": str(row["chunk_id"]),
                    "doc_id": str(row["doc_id"]),
                    "text": row["text"],
                    "faiss_id": row["faiss_id"],
                    "title": row["title"],
                    "_emb": np.array(row["embedding_array"], dtype=np.float32),
                    "score": float(row["score"]),
                }
            )
        return results

    except Exception as e:
        logger.warning("pgvector search failed (%s), trying in-memory fallback", e)
        return _search_chunks_in_memory(org_id, query_vector, k)


def _search_chunks_in_memory(
    org_id: str, query_vector: List[float], k: int = 6
) -> List[Dict]:
    """Fallback: load all org embeddings from DB and do numpy cosine search."""
    from .db_sync import get_db_connection

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT c.id as chunk_id, c.doc_id, c.text, c.faiss_id, d.title,
                       c.embedding as embedding_array
                FROM app.chunks c
                JOIN app.documents d ON d.id = c.doc_id
                WHERE c.organization_id = %s
                  AND c.embedding IS NOT NULL
                """,
                (org_id,),
            )
            rows = cursor.fetchall()

        if not rows:
            return []

        q = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            return []
        q_unit = q / q_norm

        scored = []
        for row in rows:
            emb = np.array(row["embedding_array"], dtype=np.float32)
            emb_norm = np.linalg.norm(emb)
            if emb_norm == 0:
                continue
            score = float(np.dot(emb / emb_norm, q_unit))
            scored.append((score, row, emb))

        scored.sort(key=lambda x: x[0], reverse=True)
        results = []
        for score, row, emb in scored[:k]:
            results.append(
                {
                    "chunk_id": str(row["chunk_id"]),
                    "doc_id": str(row["doc_id"]),
                    "text": row["text"],
                    "faiss_id": row["faiss_id"],
                    "title": row["title"],
                    "_emb": emb,
                    "score": score,
                }
            )
        return results

    except Exception as e:
        logger.error("In-memory fallback search also failed: %s", e)
        return []


def get_org_chunk_count(org_id: str) -> int:
    """Return total chunk count for an org (used for MMR skip decision)."""
    from .db_sync import get_db_connection

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM app.chunks WHERE organization_id = %s AND embedding_vec IS NOT NULL",
                (org_id,),
            )
            return cursor.fetchone()["count"]
    except Exception:
        return 0


def search_similar_tickets(
    org_id: str, query: str, query_vector: List[float], k: int = 3
) -> List[Dict]:
    """
    Search resolved/closed tickets for similar past issues (J.3).
    RRF fusion of title_embedding cosine + tsvector full-text.
    Returns [{"id", "title", "score", "match"}...] — best first.
    """
    from .db_sync import get_db_connection

    if not org_id or not query:
        return []

    rrf: Dict[str, float] = {}
    meta: Dict[str, Dict] = {}

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Semantic on resolved-ticket embeddings
        try:
            cursor.execute(
                """
                SELECT id::text, title, 1.0 - (title_embedding <=> %s::vector) AS score
                FROM app.tickets
                WHERE organization_id = %s
                  AND status IN ('resolved','closed')
                  AND title_embedding IS NOT NULL
                ORDER BY title_embedding <=> %s::vector
                LIMIT %s
                """,
                (str(query_vector), org_id, str(query_vector), k * 3),
            )
            for rank, row in enumerate(cursor.fetchall()):
                tid = row["id"]
                meta[tid] = {
                    "id": tid,
                    "title": row["title"],
                    "score": float(row["score"]),
                }
                rrf[tid] = rrf.get(tid, 0.0) + 1.0 / (RRF_K + rank + 1)
        except Exception as e:
            logger.debug("[similar-tickets] vector search skipped: %s", e)

        # Lexical on title+description full-text
        try:
            cursor.execute(
                """
                SELECT id::text, title
                FROM app.tickets
                WHERE organization_id = %s
                  AND status IN ('resolved','closed')
                  AND text_search @@ websearch_to_tsquery('english', %s)
                ORDER BY ts_rank(text_search, websearch_to_tsquery('english', %s)) DESC
                LIMIT %s
                """,
                (org_id, query, query, k * 3),
            )
            for rank, row in enumerate(cursor.fetchall()):
                tid = row["id"]
                meta.setdefault(tid, {"id": tid, "title": row["title"], "score": 0.0})
                rrf[tid] = rrf.get(tid, 0.0) + 1.0 / (RRF_K + rank + 1)
        except Exception as e:
            logger.debug("[similar-tickets] lexical search skipped: %s", e)

    ranked = sorted(rrf, key=lambda tid: rrf[tid], reverse=True)[:k]
    return [meta[tid] for tid in ranked]

# Configuration from environment
TOP_K = int(os.getenv("RAG_TOP_K", "6"))
MIN_SCORE = float(os.getenv("RAG_MIN_SCORE", "0.25"))
MAX_CONTEXT_CHARS = int(os.getenv("RAG_MAX_CONTEXT_CHARS", "12000"))
MMR_LAMBDA = float(os.getenv("MMR_LAMBDA", "0.7"))  # Balance relevance vs diversity
DIVERSITY_PENALTY = float(os.getenv("DIVERSITY_PENALTY", "0.3"))

# Intent-adaptive MMR lambda — controls relevance vs diversity trade-off per query type
# (Only used when KB has 50+ chunks — small KBs skip MMR entirely)
_INTENT_MMR_LAMBDA: Dict[str, float] = {
    "factual": 0.82,  # precision-first; conflicting sources reduce reliability
    "procedural": 0.70,  # balanced; steps need coverage but not duplication
    "troubleshooting": 0.55,  # diversity-first; multiple root-cause paths needed
    "comparison": 0.48,  # maximum diversity; one source per entity being compared
}

# Intent-adaptive search headroom (multiplier on TOP_K before re-ranking)
_INTENT_SEARCH_HEADROOM: Dict[str, int] = {
    "factual": 2,  # tight pool — precision over recall
    "procedural": 3,  # moderate — enough steps coverage
    "troubleshooting": 4,  # wide net — diverse root-cause candidates
    "comparison": 4,  # wide net — need representatives from each side
}


def _ensure_embeddings(chunks: List[Dict]) -> List:
    """
    Return embeddings for chunks, computing missing ones in a single batch.
    Caches computed embeddings on the chunk dict under '_emb' to avoid re-computing
    across multiple callers (MMR, coherence, diversity) in the same retrieve() pass.
    """
    missing_indices = [i for i, c in enumerate(chunks) if "_emb" not in c]
    if missing_indices:
        texts = [chunks[i].get("text", "") for i in missing_indices]
        try:
            computed = embed_texts(texts)
            for i, emb in zip(missing_indices, computed):
                chunks[i]["_emb"] = emb
        except Exception as e:
            logger.warning("Batch chunk embedding failed: %s", e)
            for i in missing_indices:
                chunks[i]["_emb"] = np.zeros(EMBEDDING_DIM)
    return [c["_emb"] for c in chunks]


def compute_semantic_coherence(
    chunks: List[Dict], query_embedding: List[float]
) -> float:
    """Compute semantic coherence between retrieved chunks and query (vectorized)."""
    if not chunks:
        return 0.0
    try:
        embs = np.array(_ensure_embeddings(chunks))  # (N, D)
        q = np.array(query_embedding)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            return 0.0
        q_unit = q / q_norm
        norms = np.linalg.norm(embs, axis=1)  # (N,)
        valid = norms > 0
        if not valid.any():
            return 0.0
        embs_unit = np.where(
            valid[:, None],
            embs / np.where(norms[:, None] > 0, norms[:, None], 1.0),
            0.0,
        )
        sims = embs_unit @ q_unit  # (N,) — single matmul
        return float(np.mean(sims[valid]))
    except Exception as e:
        logger.warning("Semantic coherence error: %s", e)
        return 0.5


def compute_diversity_score(chunks: List[Dict]) -> float:
    """Compute diversity score among retrieved chunks (vectorized upper-triangle matmul)."""
    if len(chunks) < 2:
        return 1.0
    try:
        embs = np.array(_ensure_embeddings(chunks))  # (N, D)
        norms = np.linalg.norm(embs, axis=1)  # (N,)
        valid = norms > 0
        norm_safe = np.where(norms[:, None] > 0, norms[:, None], 1.0)
        normalized = embs / norm_safe  # (N, D)
        sim_matrix = normalized @ normalized.T  # (N, N) — full cosine sim matrix
        n = len(chunks)
        rows, cols = np.triu_indices(n, k=1)  # upper-triangle indices
        pair_valid = valid[rows] & valid[cols]
        if not pair_valid.any():
            return 0.5
        avg_similarity = float(np.mean(sim_matrix[rows, cols][pair_valid]))
        return max(0.0, 1.0 - avg_similarity)
    except Exception as e:
        logger.warning("Diversity computation error: %s", e)
        return 0.5


def mmr_rerank(
    chunks: List[Dict],
    scores: List[float],
    query_embedding: List[float],
    lambda_param: float = MMR_LAMBDA,
) -> Tuple[List[Dict], List[float]]:
    """
    Re-rank chunks using Maximal Marginal Relevance (vectorized).

    Inner loop replaced with a single matmul per greedy step:
      sim(remaining, selected) = rem_unit @ sel_unit.T  → max along selected axis
    This is O(|R| × D) per step instead of O(|R| × |S| × D).
    """
    if not chunks or len(chunks) <= 1:
        return chunks, scores
    try:
        raw_embs = np.array(_ensure_embeddings(chunks))  # (N, D)
        # Pre-normalize once — reused every greedy step
        norms = np.linalg.norm(raw_embs, axis=1, keepdims=True)
        unit_embs = raw_embs / np.where(norms > 0, norms, 1.0)  # (N, D)

        selected_indices = [0]
        remaining_indices = list(range(1, len(chunks)))

        while remaining_indices and len(selected_indices) < len(chunks):
            rem = np.array(remaining_indices)
            rem_unit = unit_embs[rem]  # (|R|, D)
            sel_unit = unit_embs[selected_indices]  # (|S|, D)
            sim_matrix = rem_unit @ sel_unit.T  # (|R|, |S|)
            max_sims = sim_matrix.max(axis=1)  # (|R|,)

            relevances = np.array([scores[i] for i in remaining_indices])
            mmr_scores = lambda_param * relevances - (1.0 - lambda_param) * max_sims

            best_local = int(np.argmax(mmr_scores))
            best_idx = remaining_indices[best_local]
            selected_indices.append(best_idx)
            remaining_indices.pop(best_local)

        return [chunks[i] for i in selected_indices], [
            scores[i] for i in selected_indices
        ]
    except Exception as e:
        logger.warning("MMR re-ranking error: %s", e)
        return chunks, scores


def retrieve(
    query: str, fetch_chunk_fn=None, org_id: str = ""
) -> Tuple[List[Dict], List[str], str, List[float], List[int], Dict[str, float]]:
    """
    Hybrid retrieve: query expansion + RRF fusion of semantic/lexical/fuzzy
    search + MMR re-ranking.

    Returns:
        (chunks, sources, context, scores, faiss_ids, retrieval_metrics)
    """
    # 1) Query expansion — rewrite into alternate search queries (J.2)
    queries = [query]
    if os.getenv("RAG_QUERY_EXPANSION", "1") != "0":
        try:
            from .ai import expand_query

            queries = expand_query(query)
        except Exception as e:
            logger.debug("Query expansion failed: %s", e)

    # 2) Embed all queries in one batch
    try:
        vectors = embed_texts(queries)
    except Exception as e:
        logger.error("Query embedding failed: %s", e)
        return [], [], "", [], [], {"error": 1.0}
    query_vector = vectors[0]

    # 3) Classify query intent — drives adaptive MMR lambda and search headroom
    try:
        _intent, _intent_scores = classify_query_intent(query)
        _intent_key = _intent.value if hasattr(_intent, "value") else str(_intent)
    except Exception:
        _intent_key = "procedural"
    mmr_lambda = _INTENT_MMR_LAMBDA.get(_intent_key, MMR_LAMBDA)
    headroom = _INTENT_SEARCH_HEADROOM.get(_intent_key, 2)
    search_k = min(TOP_K * headroom, 20)

    # 4) Hybrid search per query; RRF-merge across queries + methods (J.1)
    fused: Dict[str, Dict] = {}
    fusion_scores: Dict[str, float] = {}
    for i, (q, qv) in enumerate(zip(queries, vectors)):
        try:
            hits = hybrid_search_chunks(org_id, q, qv, k=search_k)
        except Exception as e:
            logger.error("Hybrid search failed for query %d: %s", i, e)
            continue
        # Cross-query RRF: rank within each query's result list
        for rank, chunk in enumerate(hits):
            cid = chunk["chunk_id"]
            fusion_scores[cid] = fusion_scores.get(cid, 0.0) + 1.0 / (
                RRF_K + rank + 1
            )
            if cid not in fused:
                fused[cid] = chunk

    if not fused:
        return [], [], "", [], [], {"no_results": 1.0}

    ranked_ids = sorted(fused, key=lambda cid: fusion_scores[cid], reverse=True)
    chunks = [fused[cid] for cid in ranked_ids]

    # 5) Filter by minimum cosine score (computed in hybrid search)
    valid_chunks = [c for c in chunks if c.get("score", 0) >= MIN_SCORE]
    if not valid_chunks:
        return [], [], "", [], [], {"no_results": 1.0}

    filtered_scores = [c["score"] for c in valid_chunks]
    filtered_faiss_ids = [c.get("faiss_id", -1) for c in valid_chunks]

    # 6) MMR re-ranking — skip when KB is small
    try:
        _total = get_org_chunk_count(org_id)
    except Exception:
        _total = 0

    if _total < 50 or len(filtered_scores) <= TOP_K:
        final_chunks = valid_chunks[:TOP_K]
        final_scores = filtered_scores[:TOP_K]
        final_faiss_ids = filtered_faiss_ids[:TOP_K]
        if _total:
            logger.info("MMR disabled (%d chunks < 50) — using hybrid order", _total)
    else:
        try:
            reranked_chunks, reranked_scores = mmr_rerank(
                valid_chunks, filtered_scores, query_vector, lambda_param=mmr_lambda
            )
            final_chunks = reranked_chunks[:TOP_K]
            final_scores = reranked_scores[:TOP_K]
            final_faiss_ids = [c.get("faiss_id", -1) for c in final_chunks]
        except Exception as e:
            logger.warning("MMR re-ranking failed, using original order: %s", e)
            final_chunks = valid_chunks[:TOP_K]
            final_scores = filtered_scores[:TOP_K]
            final_faiss_ids = filtered_faiss_ids[:TOP_K]

    # 7) Build context and sources with PII scrubbing
    context_parts = []
    sources = []
    for i, chunk in enumerate(final_chunks):
        clean_text = scrub(chunk.get("text", ""))
        context_parts.append(f"[{i+1}] {clean_text}")
        sources.append(f"[{i+1}] {chunk.get('title', 'Unknown Document')}")

    full_context = "\n\n".join(context_parts)
    if len(full_context) > MAX_CONTEXT_CHARS:
        full_context = full_context[:MAX_CONTEXT_CHARS] + "... [truncated]"

    # 8) Compute retrieval quality metrics (reuse cached chunk embeddings)
    _top = final_scores[0] if final_scores else 0.0
    _second = final_scores[1] if len(final_scores) >= 2 else _top
    retrieval_metrics = {
        "context_relevance": compute_semantic_coherence(final_chunks, query_vector),
        "source_diversity": compute_diversity_score(final_chunks),
        "information_density": min(1.0, len(full_context) / MAX_CONTEXT_CHARS),
        "top_score": _top,
        "score_gap": _top - _second,
        "score_variance": float(np.var(final_scores)) if len(final_scores) > 1 else 0.0,
        "chunks_returned": len(final_chunks),
        "query_intent": _intent_key,
        "queries_used": len(queries),
    }

    # Clean up temporary embedding cache from chunk dicts before returning
    for c in final_chunks:
        c.pop("_emb", None)

    return (
        final_chunks,
        sources,
        full_context,
        final_scores,
        final_faiss_ids,
        retrieval_metrics,
    )


def compute_confidence(
    scores: List[float],
    model_output: str,
    num_chunks: int,
    retrieval_metrics: Dict[str, float] = None,
    query: str = "",
    kb_chunk_count: int = 100,
) -> Tuple[float, Dict[str, float]]:
    """
    Compute confidence score using CASPER adaptive scoring.

    CASPER (Contextual Adaptive Scoring with Probabilistic Ensemble Ranking)
    adapts its 7-factor weight vector based on query intent and KB density,
    outperforming the old static-weight baseline on MAE and escalation F1.

    Extra parameters (query, kb_chunk_count) default gracefully so existing
    call-sites that don't pass them continue to work.

    Returns (overall_confidence, confidence_breakdown).
    """
    return casper_confidence(
        scores=scores,
        model_output=model_output,
        num_chunks=num_chunks,
        retrieval_metrics=retrieval_metrics or {},
        query=query,
        kb_chunk_count=kb_chunk_count,
    )


def should_escalate(
    confidence: float,
    retrieval_metrics: Dict[str, float],
    model_output: str,
    conversation_length: int = 1,
    confidence_breakdown: Dict[str, Any] = None,
) -> Tuple[bool, Dict[str, Any]]:
    """
    Determine if a response should be escalated to a human.

    Uses CASPER's adaptive escalation threshold when a breakdown is provided
    (preferred), otherwise falls back to signal counting.

    Escalation triggers:
    - Confidence below adaptive/static threshold
    - Any single critical signal (no context, retrieval failure, explicit help request)
    - Two or more moderate signals combined
    """
    lower_output = model_output.lower()

    # Use CASPER's adaptive threshold if available
    threshold = 0.55
    if confidence_breakdown and "adaptive_escalation_threshold" in confidence_breakdown:
        threshold = confidence_breakdown["adaptive_escalation_threshold"]

    # Critical phrases that warrant immediate escalation
    critical_phrases = ["contact support", "i don't have enough information"]
    critical_phrase_hit = any(p in lower_output for p in critical_phrases)

    # Factual queries can be fully answered by a single authoritative chunk;
    # troubleshooting/procedural need at least 2 to cover diverse root causes.
    _intent_key = (
        (confidence_breakdown or retrieval_metrics or {}).get(
            "query_intent", "procedural"
        )
        if confidence_breakdown
        else retrieval_metrics.get("query_intent", "procedural")
    )
    _min_chunks = 1 if _intent_key == "factual" else 2

    signals = {
        "low_confidence": confidence < threshold,
        "no_relevant_context": retrieval_metrics.get("context_relevance", 1.0) < 0.3,
        "retrieval_failed": "error" in retrieval_metrics
        or "no_results" in retrieval_metrics,
        "insufficient_chunks": retrieval_metrics.get("chunks_returned", 99)
        < _min_chunks,
        "high_uncertainty": "contact support" in lower_output,
        "long_conversation": conversation_length > 8,
    }

    critical_signals = {
        "no_relevant_context",
        "retrieval_failed",
        "insufficient_chunks",
    }
    triggered = [k for k, v in signals.items() if v]
    critical_triggered = [k for k in triggered if k in critical_signals]

    escalate = critical_phrase_hit or bool(critical_triggered) or len(triggered) >= 2

    reasons = list(triggered)
    if critical_phrase_hit:
        reasons.append("critical_phrase")

    return escalate, {
        "should_escalate": escalate,
        "triggered_signals": reasons,
        "signal_count": len(reasons),
        "confidence_threshold": threshold,
        "adaptive_threshold": threshold != 0.55,
        "query_intent": (
            confidence_breakdown.get("query_intent") if confidence_breakdown else None
        ),
        "reasoning": (
            f"Escalation triggered by: {', '.join(reasons)}"
            if reasons
            else "No escalation signals"
        ),
    }

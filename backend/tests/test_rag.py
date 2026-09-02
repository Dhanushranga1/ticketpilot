"""
Tests for hybrid retrieval (Phase J):
- RRF fusion of vector + lexical + trigram search
- Query expansion (ai.expand_query)
- Similar-ticket search
- Answer cache invalidation

All tests use mocked DB; no real PostgreSQL required.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from app.rag import (
    RRF_K,
    hybrid_search_chunks,
    search_similar_tickets,
)
from app.tickets import (
    ANSWER_CACHE_TTL,
    _answer_cache,
    invalidate_answer_cache,
)

from tests.conftest import TEST_ORG_ID


def _vec(q: str):
    return [0.1] * 768


class ScriptedCursor:
    """Cursor returning different rows per query index (vector, lexical, trigram)."""

    def __init__(self, script: list[list[dict]]):
        self._script = script
        self._call = -1
        self.executed: list[str] = []

    def execute(self, query, params=None):
        self._call += 1
        self.executed.append(query)
        return self

    def fetchall(self):
        if self._call < len(self._script):
            return self._script[self._call]
        return []

    def fetchone(self):
        rows = self.fetchall()
        return rows[0] if rows else None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


class ScriptedConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


def _chunk_row(cid: str, text: str, title: str = "Doc"):
    return {
        "chunk_id": cid,
        "doc_id": f"d-{cid}",
        "text": text,
        "faiss_id": None,
        "title": title,
        "embedding_array": [0.1] * 768,
    }


# ═════════════════════════════════════════════════════════════════════════
# hybrid_search_chunks
# ═════════════════════════════════════════════════════════════════════════


class TestHybridSearch:
    def test_rrf_fusion_ranks_union(self):
        """Chunks in multiple lists rank higher than single-list chunks."""
        vector_rows = [_chunk_row("a", "VPN setup guide"), _chunk_row("b", "WiFi")]
        lexical_rows = [_chunk_row("b", "WiFi"), _chunk_row("c", "Wi-Fi FAQ")]
        trigram_rows = []  # no fuzzy hits

        cursor = ScriptedCursor([vector_rows, lexical_rows, trigram_rows])
        conn = ScriptedConn(cursor)

        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = hybrid_search_chunks(TEST_ORG_ID, "vpn wifi", _vec("q"), k=10)

        ids = [c["chunk_id"] for c in results]
        # "b" appears in both lists → strongest fused score
        assert ids[0] == "b"
        assert set(ids) == {"a", "b", "c"}

    def test_trigram_hits_included(self):
        vector_rows = [_chunk_row("a", "password reset")]
        lexical_rows = []
        trigram_rows = [_chunk_row("z", "passwrd resett guide")]

        cursor = ScriptedCursor([vector_rows, lexical_rows, trigram_rows])
        conn = ScriptedConn(cursor)

        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = hybrid_search_chunks(TEST_ORG_ID, "passwrd", _vec("q"), k=10)

        ids = [c["chunk_id"] for c in results]
        assert "z" in ids

    def test_empty_results(self):
        cursor = ScriptedCursor([[], [], []])
        conn = ScriptedConn(cursor)

        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = hybrid_search_chunks(TEST_ORG_ID, "xyz", _vec("q"), k=10)

        assert results == []

    def test_lexical_failure_degrades_to_vector_only(self):
        """When tsvector/trgm queries raise, vector results still return."""
        class RaisingCursor:
            def execute(self, query, params=None):
                if "websearch_to_tsquery" in query:
                    raise RuntimeError("tsquery parse error")
                return self

            def fetchall(self):
                return [_chunk_row("a", "vpn")]

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        conn = ScriptedConn(RaisingCursor())
        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = hybrid_search_chunks(TEST_ORG_ID, "vpn", _vec("q"), k=10)

        assert [c["chunk_id"] for c in results] == ["a"]

    def test_rrf_k_constant(self):
        assert RRF_K == 60


# ═════════════════════════════════════════════════════════════════════════
# expand_query (ai.py)
# ═════════════════════════════════════════════════════════════════════════


class TestExpandQuery:
    def test_expands_with_alternatives(self):
        from app.ai import expand_query

        with patch("app.ai._call_llm") as mock_llm:
            mock_llm.return_value = '{"queries": ["cannot log in", "authentication failure", "password reset"]}'
            out = expand_query("cant login")

        assert out[0] == "cant login"
        assert "cannot log in" in out
        assert len(out) <= 3

    def test_failure_returns_original_only(self):
        from app.ai import expand_query

        with patch("app.ai._call_llm", side_effect=RuntimeError("no key")):
            out = expand_query("cant login")

        assert out == ["cant login"]

    def test_dedupes_and_caps(self):
        from app.ai import expand_query

        with patch("app.ai._call_llm") as mock_llm:
            mock_llm.return_value = '{"queries": ["cant login", "a", "b", "c"]}'
            out = expand_query("cant login")

        assert out == ["cant login", "a", "b"]

    def test_garbage_json_returns_original(self):
        from app.ai import expand_query

        with patch("app.ai._call_llm", return_value="not json at all"):
            out = expand_query("cant login")

        assert out == ["cant login"]


# ═════════════════════════════════════════════════════════════════════════
# search_similar_tickets
# ═════════════════════════════════════════════════════════════════════════


class TestSimilarTickets:
    def test_rrf_over_vector_and_lexical(self):
        vector_rows = [
            {"id": "t1", "title": "VPN not connecting", "score": 0.9},
            {"id": "t2", "title": "WiFi down", "score": 0.7},
        ]
        lexical_rows = [
            {"id": "t2", "title": "WiFi down"},
            {"id": "t3", "title": "WiFi adapter missing"},
        ]

        cursor = ScriptedCursor([vector_rows, lexical_rows])
        conn = ScriptedConn(cursor)

        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = search_similar_tickets(
                TEST_ORG_ID, "wifi not working", [0.1] * 768, k=3
            )

        ids = [t["id"] for t in results]
        # t2 in both lists → top fused rank
        assert ids[0] == "t2"
        assert set(ids) == {"t1", "t2", "t3"}

    def test_empty_when_no_hits(self):
        cursor = ScriptedCursor([[], []])
        conn = ScriptedConn(cursor)

        with patch("app.db_sync.get_db_connection", return_value=conn):
            results = search_similar_tickets(TEST_ORG_ID, "nothing", [0.1] * 768)

        assert results == []


# ═════════════════════════════════════════════════════════════════════════
# Answer cache
# ═════════════════════════════════════════════════════════════════════════


class TestAnswerCache:
    def setup_method(self):
        _answer_cache.clear()

    def test_invalidate_org_only(self):
        _answer_cache[f"{TEST_ORG_ID}:abc"] = ({"x": 1}, time.monotonic())
        _answer_cache["other-org:abc"] = ({"x": 2}, time.monotonic())

        invalidate_answer_cache(TEST_ORG_ID)

        assert f"{TEST_ORG_ID}:abc" not in _answer_cache
        assert "other-org:abc" in _answer_cache

    def test_ttl_constant(self):
        assert ANSWER_CACHE_TTL > 0

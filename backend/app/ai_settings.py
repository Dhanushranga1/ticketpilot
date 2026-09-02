"""
Runtime AI configuration — checks DB first, falls back to env vars.
Allows admin to configure models/keys via UI without server restart.

Config keys stored in app.ai_settings.config JSONB:
  gen_model, gen_api_key, gen_api_base   → generation (ai.py)
  embed_model, embed_api_key, embed_dim  → embeddings
  temperature, max_tokens                → generation params
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# In-memory cache: (config_dict, timestamp)
_cache: tuple[dict[str, Any], float] | None = None
_CACHE_TTL = 60.0  # seconds


def _resolve(key: str, env_fallback: str | None = None, default: Any = "") -> Any:
    """Return DB setting if set, else env var, else default."""
    import time

    global _cache
    now = time.monotonic()

    if _cache and (now - _cache[1]) < _CACHE_TTL:
        db_val = _cache[0].get(key)
        if db_val is not None and db_val != "":
            return db_val
    else:
        # Fetch fresh from DB
        try:
            from .db_sync import get_db_connection

            with get_db_connection() as conn:
                row = conn.execute(
                    "SELECT config FROM app.ai_settings LIMIT 1"
                ).fetchone()
            if row:
                config = row["config"] if isinstance(row, dict) else row[0]
                if isinstance(config, str):
                    config = json.loads(config)
                _cache = (dict(config or {}), now)
                db_val = (config or {}).get(key)
                if db_val is not None and db_val != "":
                    return db_val
        except Exception as exc:
            logger.debug("AI settings DB read failed: %s — falling back to env", exc)

    return os.getenv(env_fallback or key.upper(), default)


def gen_model() -> str:
    return _resolve("gen_model", "GENAI_MODEL", "gemini-2.0-flash")


def gen_api_key() -> str:
    model = gen_model()
    # For Gemini models, check GOOGLE_API_KEY too
    if model.startswith("gemini-"):
        key = _resolve("gen_api_key", "GOOGLE_API_KEY", "")
        if key:
            return key
        key = _resolve("gen_api_key", "GENAI_API_KEY", "")
        if key:
            return key
    return _resolve("gen_api_key", "GENAI_API_KEY", "")


def gen_api_base() -> str:
    return _resolve("gen_api_base", "GENAI_API_BASE", "")


def embed_model() -> str:
    return _resolve("embed_model", "EMBEDDING_MODEL", "gemini-embedding-001")


def embed_api_key() -> str:
    model = embed_model()
    key = _resolve("embed_api_key", "EMBEDDING_API_KEY", "")
    if key:
        return key
    if model.startswith("gemini-embedding-"):
        return _resolve("embed_api_key", "GOOGLE_API_KEY", "")
    return ""


def embed_dim() -> int:
    explicit = _resolve("embed_dim", "EMBEDDING_DIM", "")
    if explicit:
        return int(explicit)
    # Auto-detect from model
    _DIM_MAP = {
        "gemini-embedding-001": 768,
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
    }
    return _DIM_MAP.get(embed_model(), 768)


def temperature() -> float:
    return float(_resolve("temperature", "GENAI_TEMPERATURE", "0.2"))


def max_tokens() -> int:
    return int(_resolve("max_tokens", "GENAI_MAX_OUTPUT_TOKENS", "1024"))


def invalidate_cache():
    """Force re-fetch on next call (call after any DB update)."""
    global _cache
    _cache = None

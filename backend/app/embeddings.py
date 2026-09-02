"""
Embeddings — provider-agnostic. Settings resolved from DB (via ai_settings.py)
first, env vars as fallback.
"""

import asyncio
import logging
import os
import time
from typing import List

import httpx

from .ai_settings import embed_api_key
from .ai_settings import embed_dim as _embed_dim
from .ai_settings import embed_model

logger = logging.getLogger(__name__)

MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 2.0
RETRY_DELAY_429 = 15.0
INTER_BATCH_DELAY = 0.5
BATCH_SIZE = 20
MAX_TEXT_LENGTH = 20000


def _is_rate_limit(exc: Exception) -> bool:
    if hasattr(exc, "response") and hasattr(exc.response, "status_code"):
        return exc.response.status_code == 429
    if "429" in str(exc) or "Too Many Requests" in str(exc):
        return True
    return False


def _detect_provider(model: str) -> str:
    if model.startswith("gemini-embedding-"):
        return "google"
    if model.startswith("text-embedding-"):
        return "openai"
    return "jina"


def _get_api_key(provider: str) -> str:
    key = embed_api_key()
    if key:
        return key
    if provider == "google":
        key = embed_api_key()
    if key:
        return key
    raise RuntimeError(f"No API key for {provider}. Configure it in Settings → AI.")


# ── Google Gemini Embedding API ──────────────────────────────


def _call_google(texts: List[str], api_key: str) -> List[List[float]]:
    model = embed_model()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={api_key}"
    requests = [
        {"model": f"models/{model}", "content": {"parts": [{"text": t}]}} for t in texts
    ]
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            url,
            headers={"Content-Type": "application/json"},
            json={"requests": requests},
        )
        resp.raise_for_status()
    return [e["values"] for e in resp.json().get("embeddings", [])]


async def _call_google_async(texts: List[str], api_key: str) -> List[List[float]]:
    model = embed_model()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={api_key}"
    requests = [
        {"model": f"models/{model}", "content": {"parts": [{"text": t}]}} for t in texts
    ]
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            url,
            headers={"Content-Type": "application/json"},
            json={"requests": requests},
        )
        resp.raise_for_status()
    return [e["values"] for e in resp.json().get("embeddings", [])]


# ── OpenAI-compatible Embedding API (OpenAI, Groq, etc.) ────


def _openai_embed_url() -> str:
    return os.getenv("EMBEDDING_API_BASE", "https://api.openai.com/v1/embeddings")


def _call_openai(texts: List[str], api_key: str) -> List[List[float]]:
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            _openai_embed_url(),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"model": embed_model(), "input": texts},
        )
        resp.raise_for_status()
    return [
        item["embedding"]
        for item in sorted(resp.json()["data"], key=lambda x: x["index"])
    ]


async def _call_openai_async(texts: List[str], api_key: str) -> List[List[float]]:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            _openai_embed_url(),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"model": embed_model(), "input": texts},
        )
        resp.raise_for_status()
    return [
        item["embedding"]
        for item in sorted(resp.json()["data"], key=lambda x: x["index"])
    ]


# ── Jina Embedding API ──────────────────────────────────────


def _call_jina(texts: List[str], api_key: str) -> List[List[float]]:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": embed_model(), "input": texts}
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            "https://api.jina.ai/v1/embeddings", headers=headers, json=payload
        )
        resp.raise_for_status()
    return [
        item["embedding"]
        for item in sorted(resp.json()["data"], key=lambda x: x["index"])
    ]


async def _call_jina_async(texts: List[str], api_key: str) -> List[List[float]]:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": embed_model(), "input": texts}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "https://api.jina.ai/v1/embeddings", headers=headers, json=payload
        )
        resp.raise_for_status()
    return [
        item["embedding"]
        for item in sorted(resp.json()["data"], key=lambda x: x["index"])
    ]


# ── Router ──────────────────────────────────────────────────
# Provider detected per call from the current model name — admin UI changes
# take effect immediately without a restart.

_call_map = {
    "google": (_call_google, _call_google_async),
    "openai": (_call_openai, _call_openai_async),
    "jina": (_call_jina, _call_jina_async),
}


def _current_provider() -> str:
    return _detect_provider(embed_model())


def _call(texts: List[str], api_key: str) -> List[List[float]]:
    return _call_map[_current_provider()][0](texts, api_key)


async def _call_async(texts: List[str], api_key: str) -> List[List[float]]:
    return await _call_map[_current_provider()][1](texts, api_key)


# ── Public API ──────────────────────────────────────────────


class EmbeddingError(Exception):
    pass


def _clean(text: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise EmbeddingError("Text must be a non-empty string")
    return text.strip()[:MAX_TEXT_LENGTH]


def embed_single_text_with_retry(text: str) -> List[float]:
    api_key = _get_api_key(_current_provider())
    validated = _clean(text)
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            return _call([validated], api_key)[0]
        except Exception as e:
            delay = (
                RETRY_DELAY_429
                if _is_rate_limit(e)
                else RETRY_DELAY_SECONDS * (attempt + 1)
            )
            logger.warning(
                f"Embedding attempt {attempt + 1}/{MAX_RETRY_ATTEMPTS} failed: {e}"
            )
            if attempt + 1 < MAX_RETRY_ATTEMPTS:
                time.sleep(delay)
            else:
                raise EmbeddingError(
                    f"All {MAX_RETRY_ATTEMPTS} attempts failed: {e}"
                ) from e


def embed_texts(texts: List[str]) -> List[List[float]]:
    if not texts:
        raise EmbeddingError("Cannot embed empty list of texts")
    provider = _current_provider()
    dim = _embed_dim()
    api_key = _get_api_key(provider)
    cleaned = [_clean(t) for t in texts]
    embeddings: List[List[float]] = []
    failed_count = 0
    total_batches = (len(cleaned) + BATCH_SIZE - 1) // BATCH_SIZE
    logger.info(
        f"Embedding {len(cleaned)} texts in {total_batches} batch(es) via {provider}/{embed_model()}"
    )

    for i, batch_start in enumerate(range(0, len(cleaned), BATCH_SIZE)):
        batch = cleaned[batch_start : batch_start + BATCH_SIZE]
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                embeddings.extend(_call(batch, api_key))
                break
            except Exception as e:
                logger.warning(
                    f"Batch {i + 1} attempt {attempt + 1}/{MAX_RETRY_ATTEMPTS} failed: {e}"
                )
                if attempt + 1 < MAX_RETRY_ATTEMPTS:
                    time.sleep(RETRY_DELAY_SECONDS * (attempt + 1))
                else:
                    failed_count += len(batch)
                    embeddings.extend([[0.0] * dim] * len(batch))
        if i < total_batches - 1:
            time.sleep(INTER_BATCH_DELAY)

    failure_rate = failed_count / len(texts)
    if failure_rate > 0.5:
        raise EmbeddingError(
            f"High embedding failure rate: {failure_rate:.1%} ({failed_count}/{len(texts)})"
        )
    return embeddings


async def embed_texts_async(texts: List[str]) -> List[List[float]]:
    if not texts:
        raise EmbeddingError("Cannot embed empty list of texts")
    provider = _current_provider()
    dim = _embed_dim()
    api_key = _get_api_key(provider)
    cleaned = [_clean(t) for t in texts]
    embeddings: List[List[float]] = []
    failed_count = 0
    total_batches = (len(cleaned) + BATCH_SIZE - 1) // BATCH_SIZE
    logger.info(
        f"Embedding {len(cleaned)} texts in {total_batches} batch(es) via {provider}/{embed_model()} (async)"
    )

    for i, batch_start in enumerate(range(0, len(cleaned), BATCH_SIZE)):
        batch = cleaned[batch_start : batch_start + BATCH_SIZE]
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                embeddings.extend(await _call_async(batch, api_key))
                break
            except Exception as e:
                delay = (
                    RETRY_DELAY_429
                    if _is_rate_limit(e)
                    else RETRY_DELAY_SECONDS * (attempt + 1)
                )
                logger.warning(
                    f"Batch {i + 1} attempt {attempt + 1}/{MAX_RETRY_ATTEMPTS} failed: {e}"
                )
                if attempt + 1 < MAX_RETRY_ATTEMPTS:
                    await asyncio.sleep(delay)
                else:
                    failed_count += len(batch)
                    embeddings.extend([[0.0] * dim] * len(batch))
        if i < total_batches - 1:
            await asyncio.sleep(INTER_BATCH_DELAY)

    failure_rate = failed_count / len(texts)
    if failure_rate > 0.5:
        raise EmbeddingError(
            f"High embedding failure rate: {failure_rate:.1%} ({failed_count}/{len(texts)})"
        )
    return embeddings

"""
AI generation — provider-agnostic. Provider auto-detected from model name prefix.
Settings resolved from DB (via ai_settings.py) first, env vars as fallback.
"""

import hashlib
import json
import logging
import time
from typing import Any, Dict, Optional, Tuple

import httpx
from pydantic import BaseModel, ValidationError

from .ai_settings import gen_api_base, gen_api_key, gen_model, max_tokens, temperature

logger = logging.getLogger(__name__)

MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 2.0


class Citation(BaseModel):
    index: int
    confidence: float
    relevance_score: float


class GeminiResponse(BaseModel):
    response: str
    citations_used: list[Citation]
    confidence_indicators: Dict[str, float]
    escalation_signals: Dict[str, Any]
    retrieval_quality: Dict[str, float]
    reasoning_trace: Optional[str] = None


SYSTEM_PROMPT = """You are TicketPilot AI, a friendly and expert customer support assistant.

PERSONALITY GUIDELINES:
- Start your response with a warm, helpful greeting when appropriate
- Use a conversational, empathetic tone while remaining professional
- Show genuine interest in helping resolve the customer's issue
- If the customer seems frustrated, acknowledge their feelings

CRITICAL RESPONSE FORMAT:
You MUST respond with valid JSON matching this exact schema:
{
  "response": "Your helpful answer with proper [N] citations",
  "citations_used": [
    {"index": 1, "confidence": 0.95, "relevance_score": 0.87}
  ],
  "confidence_indicators": {
    "source_quality": 0.85,
    "answer_completeness": 0.92,
    "semantic_coherence": 0.88,
    "citation_coverage": 0.95
  },
  "escalation_signals": {
    "requires_human": false,
    "uncertainty_level": "low",
    "complexity_score": 0.3,
    "missing_info": []
  },
  "retrieval_quality": {
    "context_relevance": 0.87,
    "source_diversity": 0.73,
    "information_density": 0.91
  },
  "reasoning_trace": "Brief explanation of reasoning process"
}

ANSWER GUIDELINES:
- Use ONLY provided context sources
- Include [N] citations for every factual claim
- Be concise but comprehensive
- If insufficient information, indicate clearly in escalation_signals
- Provide confidence scores between 0.0-1.0 for all metrics
- Set requires_human=true if answer requires human expertise"""


# ── Provider detection ──────────────────────────────────────


def _detect_provider(model: str) -> str:
    if model.startswith("gemini-"):
        return "google"
    if model.startswith("claude-"):
        return "anthropic"
    return "openai_compat"


def _call_llm(prompt: str, json_mode: bool = True) -> str:
    model = gen_model()
    provider = _detect_provider(model)
    temp = temperature()
    max_tok = max_tokens()

    if provider == "google":
        key = gen_api_key()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        payload = {
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temp, "maxOutputTokens": max_tok},
        }
        if json_mode:
            payload["generationConfig"]["response_mime_type"] = "application/json"
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                url, headers={"Content-Type": "application/json"}, json=payload
            )
            resp.raise_for_status()
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    if provider == "anthropic":
        key = gen_api_key()
        payload = {
            "model": model,
            "max_tokens": max_tok,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": prompt}],
        }
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            resp.raise_for_status()
        return resp.json()["content"][0]["text"]

    # OpenAI-compatible (Groq, Together, OpenAI, etc.)
    key = gen_api_key()
    base_url = (gen_api_base() or "https://api.groq.com/openai/v1").rstrip("/")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": temp,
        "max_tokens": max_tok,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


# ── Response parsing ────────────────────────────────────────


def validate_response(text: str) -> Optional[GeminiResponse]:
    try:
        cleaned = text.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        return GeminiResponse.model_validate(json.loads(cleaned.strip()))
    except (json.JSONDecodeError, ValidationError) as e:
        logger.warning(f"Response validation failed: {e}")
        return None


# ── Generation ──────────────────────────────────────────────


def generate_structured_completion(
    context: str, question: str, sources: list[str]
) -> Tuple[GeminiResponse, int]:
    prompt = f"""{SYSTEM_PROMPT}

CONTEXT:
{context}

SOURCES:
{chr(10).join(sources)}

USER QUESTION: {question}

RESPOND WITH VALID JSON ONLY:"""
    start = time.time()
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            text = _call_llm(prompt, json_mode=True)
            validated = validate_response(text) if text else None
            if validated:
                return validated, int((time.time() - start) * 1000)
            logger.warning(f"Invalid response on attempt {attempt + 1}")
        except Exception as e:
            is_429 = (
                hasattr(e, "response") and getattr(e.response, "status_code", 0) == 429
            )
            logger.error(f"Generation attempt {attempt + 1} failed: {e}")
            if attempt < MAX_RETRY_ATTEMPTS - 1:
                time.sleep(15.0 if is_429 else RETRY_DELAY_SECONDS)
    logger.error("All structured attempts failed")
    return generate_fallback_response(context, question, sources, start)


def generate_fallback_response(
    context: str, question: str, sources: list[str], start: float
) -> Tuple[GeminiResponse, int]:
    try:
        text = _call_llm(
            f"Answer concisely with [N] citations using this context:\n\n{context}\n\nQuestion: {question}",
            json_mode=False,
        )
        fb = GeminiResponse(
            response=text or "Unable to process your request.",
            citations_used=[],
            confidence_indicators={
                "source_quality": 0.5,
                "answer_completeness": 0.3,
                "semantic_coherence": 0.4,
                "citation_coverage": 0.2,
            },
            escalation_signals={
                "requires_human": True,
                "uncertainty_level": "high",
                "complexity_score": 0.9,
                "missing_info": ["structured_response_failed"],
            },
            retrieval_quality={
                "context_relevance": 0.5,
                "source_diversity": 0.5,
                "information_density": 0.5,
            },
            reasoning_trace="Fallback due to structured generation failure",
        )
        return fb, int((time.time() - start) * 1000)
    except Exception as e:
        logger.error(f"Fallback failed: {e}")
        fb = GeminiResponse(
            response="Technical difficulties. Please contact support.",
            citations_used=[],
            confidence_indicators=dict.fromkeys(
                (
                    "source_quality",
                    "answer_completeness",
                    "semantic_coherence",
                    "citation_coverage",
                ),
                0.0,
            ),
            escalation_signals={
                "requires_human": True,
                "uncertainty_level": "critical",
                "complexity_score": 1.0,
                "missing_info": ["generation_system_failure"],
            },
            retrieval_quality=dict.fromkeys(
                ("context_relevance", "source_diversity", "information_density"), 0.0
            ),
            reasoning_trace="System failure",
        )
        return fb, int((time.time() - start) * 1000)


def generate_completion(
    context: str, question: str, sources: list[str]
) -> Tuple[str, int | None]:
    try:
        structured, lat = generate_structured_completion(context, question, sources)
        return structured.response, lat
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        return "Technical difficulties. Please contact support.", None


def compute_prompt_hash(context: str, question: str) -> str:
    return hashlib.sha256(f"{context}\n---\n{question}".encode()).hexdigest()[:16]


KB_DRAFT_PROMPT = """You are writing a knowledge base article for an internal IT knowledge base.
Summarize the conversation below into a reusable how-to article.

Respond with VALID JSON only, matching this exact schema:
{
  "title": "Short descriptive article title (max 80 chars)",
  "content": "Markdown-formatted article covering the problem, resolution steps, and notes. 200-600 words."
}

GUIDELINES:
- Strip customer names, emails, ticket IDs, and any PII
- Write steps so a colleague can resolve the same issue next time
- If the ticket lacks a clear resolution, say so in content and suggest escalation follow-up"""


def generate_kb_draft(conversation: str) -> Tuple[str, str]:
    """Generate a KB article draft from a ticket conversation. Returns (title, content)."""
    prompt = f"{KB_DRAFT_PROMPT}\n\nCONVERSATION:\n{conversation}"
    try:
        text = _call_llm(prompt, json_mode=True)
        cleaned = text.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        data = json.loads(cleaned)
        return str(data.get("title", "Untitled KB Article")), str(data.get("content", ""))
    except Exception as e:
        logger.error("KB draft generation failed: %s", e)
        raise

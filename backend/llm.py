from __future__ import annotations

import asyncio
import json
import logging
import re
from threading import Lock
from typing import Any

import google.generativeai as genai
from groq import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AsyncGroq,
    AuthenticationError,
    BadRequestError,
    PermissionDeniedError,
    RateLimitError,
)

from config import settings

logger = logging.getLogger(__name__)

_ALLOWED_SENTIMENTS = {"very_negative", "negative", "neutral", "positive"}
_ALLOWED_CATEGORIES = {
    "service_complaint",
    "fraud_accusation",
    "general_negative",
    "product_complaint",
    "other",
}

_NEUTRAL_DEFAULT: dict[str, Any] = {
    "sentiment": "neutral",
    "score": 0.0,
    "category": "other",
    "keywords_matched": [],
    "bad_buzz_suggestions": [],
}

_GROQ_FALLBACK_EXCEPTIONS = (
    RateLimitError,
    APITimeoutError,
    APIConnectionError,
    APIError,
    AuthenticationError,
    PermissionDeniedError,
    BadRequestError,
)

_PROVIDER_SEQUENCE = ("groq", "gemini")
_PROVIDER_ROTATION_LOCK = Lock()
_provider_rotation_index = 0


def build_prompt(post_text: str, client_name: str, keywords: list[str]) -> str:
    safe_keywords = [kw.strip() for kw in keywords if kw and kw.strip()]
    keywords_str = ", ".join(safe_keywords)

    return f"""
Tu es un expert en e-reputation pour les institutions financieres tunisiennes.
Contexte business:
- Canal: post Facebook groupe
- Usage: triage operationnel par un community manager
- Langues: Darija tunisienne, francais, arabe standard
- Priorite: detecter signaux de bad buzz et recommander reponses pragmatiques

Instructions critiques:
- Retourne UNIQUEMENT un objet JSON valide.
- N'ajoute aucun markdown, aucun commentaire, aucun texte hors JSON.
- Si le post est ambigu, choisis "neutral" avec score proche de 0.
- "keywords_matched" contient uniquement des mots-cles effectivement presents dans le post.
- "bad_buzz_suggestions" contient 3 actions courtes, concretes, orientee CM.

Schema de sortie strict:
{{
  "sentiment": "very_negative|negative|neutral|positive",
  "score": <float entre -1.0 et 1.0>,
  "category": "service_complaint|fraud_accusation|general_negative|product_complaint|other",
  "keywords_matched": [<liste des mots-cles du client trouves>],
  "bad_buzz_suggestions": [
    "<Strategie 1: reponse empathique publique>",
    "<Strategie 2: escalade interne + contact direct>",
    "<Strategie 3: post de clarification ou contre-narration>"
  ]
}}

Rappels d'analyse:
- Une accusation explicite d'arnaque/fraude => tendance "fraud_accusation".
- Une plainte service/retard/support => tendance "service_complaint".
- Si tonalite non negative avec simple mention marque => "neutral" ou "positive".

Client surveille: {client_name}
Mots-cles du client: {keywords_str}
Post: {post_text}
""".strip()


def _strip_markdown_fences(raw_text: str) -> str:
    text = raw_text.strip()
    text = re.sub(r"^```(?:json)?\\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\\s*```$", "", text)
    return text.strip()


def _extract_json_block(raw_text: str) -> str:
    cleaned = _strip_markdown_fences(raw_text)
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return cleaned

    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if match:
        return match.group(0)
    return cleaned


def _clamp_score(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(-1.0, min(1.0, number))


def _normalize_result(payload: dict[str, Any]) -> dict[str, Any]:
    sentiment = str(payload.get("sentiment", "neutral")).strip().lower()
    if sentiment not in _ALLOWED_SENTIMENTS:
        sentiment = "neutral"

    category = str(payload.get("category", "other")).strip().lower()
    if category not in _ALLOWED_CATEGORIES:
        category = "other"

    keywords = payload.get("keywords_matched", [])
    if not isinstance(keywords, list):
        keywords = []

    suggestions = payload.get("bad_buzz_suggestions", [])
    if not isinstance(suggestions, list):
        suggestions = []

    return {
        "sentiment": sentiment,
        "score": _clamp_score(payload.get("score", 0.0)),
        "category": category,
        "keywords_matched": [str(item).strip() for item in keywords if str(item).strip()],
        "bad_buzz_suggestions": [str(item).strip() for item in suggestions if str(item).strip()][:3],
    }


def _parse_json_response_with_status(raw_text: str) -> tuple[dict[str, Any], bool]:
    if not raw_text:
        return dict(_NEUTRAL_DEFAULT), False

    json_block = _extract_json_block(raw_text)
    try:
        payload = json.loads(json_block)
    except json.JSONDecodeError:
        return dict(_NEUTRAL_DEFAULT), False

    if not isinstance(payload, dict):
        return dict(_NEUTRAL_DEFAULT), False

    return _normalize_result(payload), True


def parse_json_response(raw_text: str) -> dict[str, Any]:
    parsed, _ = _parse_json_response_with_status(raw_text)
    return parsed


def _match_keywords(post_text: str, keywords: list[str]) -> list[str]:
    lowered_text = (post_text or "").lower()
    matched: list[str] = []
    for keyword in keywords:
        key = (keyword or "").strip()
        if key and key.lower() in lowered_text:
            matched.append(key)
    return matched


def _build_key_pool(primary_key: str, extra_keys: tuple[str, ...]) -> list[str]:
    ordered = [str(primary_key or "").strip(), *[str(item or "").strip() for item in extra_keys]]
    filtered = [item for item in ordered if item]
    if not filtered:
        return []

    # Keep order while deduplicating.
    return list(dict.fromkeys(filtered))


def _next_provider_order() -> tuple[str, str]:
    global _provider_rotation_index

    with _PROVIDER_ROTATION_LOCK:
        first = _PROVIDER_SEQUENCE[_provider_rotation_index]
        _provider_rotation_index = (_provider_rotation_index + 1) % len(_PROVIDER_SEQUENCE)

    second = "gemini" if first == "groq" else "groq"
    return first, second


async def call_groq(prompt: str, api_key: str) -> str:
    if not api_key:
        raise RuntimeError("Missing GROQ_API_KEY")

    client = AsyncGroq(api_key=api_key)
    response = await client.chat.completions.create(
        model=settings.groq_model,
        messages=[
            {"role": "system", "content": "Return only one JSON object and nothing else."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
        max_tokens=400,
        response_format={"type": "json_object"},
    )

    if not response.choices:
        return ""
    return response.choices[0].message.content or ""


def _call_gemini_sync(prompt: str, api_key: str) -> str:
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(settings.gemini_model)
    generation_config = {
        "temperature": 0.1,
        "max_output_tokens": 400,
        "response_mime_type": "application/json",
    }

    try:
        response = model.generate_content(prompt, generation_config=generation_config)
    except Exception:
        generation_config.pop("response_mime_type", None)
        response = model.generate_content(prompt, generation_config=generation_config)

    if hasattr(response, "text") and response.text:
        return response.text

    candidate_text_parts: list[str] = []
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None)
        if not parts:
            continue
        for part in parts:
            text = getattr(part, "text", None)
            if text:
                candidate_text_parts.append(text)

    return "\n".join(candidate_text_parts)


async def call_gemini(prompt: str, api_key: str) -> str:
    return await asyncio.to_thread(_call_gemini_sync, prompt, api_key)


async def _call_groq_with_key_rotation(prompt: str, keys: list[str]) -> str:
    if not keys:
        raise RuntimeError("Missing GROQ_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_groq(prompt, key)
        except _GROQ_FALLBACK_EXCEPTIONS as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Groq key %s/%s failed (%s). Trying next Groq key.",
                    index,
                    len(keys),
                    exc,
                )
            else:
                logger.warning("Groq key %s/%s failed (%s).", index, len(keys), exc)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Groq key %s/%s error (%s). Trying next Groq key.",
                    index,
                    len(keys),
                    exc,
                )
            else:
                logger.warning("Groq key %s/%s error (%s).", index, len(keys), exc)

    raise last_error or RuntimeError("Groq failed with all configured keys")


async def _call_gemini_with_key_rotation(prompt: str, keys: list[str]) -> str:
    if not keys:
        raise RuntimeError("Missing GEMINI_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_gemini(prompt, key)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Gemini key %s/%s failed (%s). Trying next Gemini key.",
                    index,
                    len(keys),
                    exc,
                )
            else:
                logger.warning("Gemini key %s/%s failed (%s).", index, len(keys), exc)

    raise last_error or RuntimeError("Gemini failed with all configured keys")


async def _analyze_with_provider(provider: str, prompt: str, keys: list[str]) -> dict[str, Any]:
    if provider == "groq":
        raw_result = await _call_groq_with_key_rotation(prompt, keys)
    elif provider == "gemini":
        raw_result = await _call_gemini_with_key_rotation(prompt, keys)
    else:
        raise ValueError(f"Unsupported provider: {provider}")

    parsed, parse_ok = _parse_json_response_with_status(raw_result)
    if not parse_ok:
        raise ValueError(f"{provider} returned invalid or non-JSON content")
    return parsed


async def analyze_post(post_text: str, client_name: str, keywords: list[str]) -> dict[str, Any]:
    prompt = build_prompt(post_text, client_name, keywords)
    parsed: dict[str, Any] = dict(_NEUTRAL_DEFAULT)

    groq_keys = _build_key_pool(settings.groq_api_key, settings.groq_api_keys)
    gemini_keys = _build_key_pool(settings.gemini_api_key, settings.gemini_api_keys)
    provider_order = _next_provider_order()

    provider_errors: dict[str, Exception] = {}

    for provider in provider_order:
        keys = groq_keys if provider == "groq" else gemini_keys
        if not keys:
            provider_errors[provider] = RuntimeError(f"No {provider} API keys configured")
            logger.warning("Skipping %s because no API key is configured.", provider.capitalize())
            continue

        try:
            parsed = await _analyze_with_provider(provider, prompt, keys)
            break
        except Exception as exc:
            provider_errors[provider] = exc
            other = "Gemini" if provider == "groq" else "Groq"
            logger.warning("%s failed (%s). Trying %s.", provider.capitalize(), exc, other)
    else:
        logger.error(
            "Both LLM providers failed. Groq error: %s | Gemini error: %s",
            provider_errors.get("groq"),
            provider_errors.get("gemini"),
        )
        parsed = dict(_NEUTRAL_DEFAULT)

    if not parsed.get("keywords_matched"):
        parsed["keywords_matched"] = _match_keywords(post_text, keywords)

    return _normalize_result(parsed)

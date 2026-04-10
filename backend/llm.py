from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import google.generativeai as genai
import httpx
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

_CEREBRAS_FALLBACK_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.TransportError,
    httpx.HTTPStatusError,
)

_PROVIDER_SEQUENCE = ("cerebras", "gemini", "groq")


def build_prompt(post_text: str, client_name: str, keywords: list[str]) -> str:
    safe_keywords = [kw.strip() for kw in keywords if kw and kw.strip()]
    keywords_str = ", ".join(safe_keywords)

    return f"""
Tu es un expert en e-reputation pour les institutions financieres tunisiennes.

Contexte:
- Canal: post Facebook groupe surveille pour le client: {client_name}
- Le post a DEJA passe un filtre de pertinence (mots-cles detectes). Ton role est d'evaluer le SENTIMENT et la GRAVITE, pas de revalider la pertinence.
- Langues possibles: Darija tunisienne, francais, arabe standard, melanges.
- Usage: triage operationnel temps-reel par un community manager.

Consignes:
1. Retourne UNIQUEMENT un objet JSON valide, sans markdown, sans commentaires.
2. Evalue le sentiment du point de vue d'un client ou citoyen parlant d'une banque tunisienne ou du secteur bancaire.
3. "negative" ou "very_negative": plainte, frustration, arnaque presumee, probleme de service, ton hostile envers une banque ou service bancaire — meme si le nom exact du client n'est pas mentionne.
4. "positive": satisfaction, eloge, recommandation favorable.
5. "neutral": simple partage d'info, question sans frustration, ou contenu sans tonalite claire.
6. Score: float entre -1.0 (tres negatif) et +1.0 (tres positif). Sois precis — evite de rester a 0.0 si une emotion est detectee.
7. "keywords_matched": liste des mots-cles (fournis ou similaires) presents dans le post. Inclure les equivalents Darija/arabe.
8. "bad_buzz_suggestions": exactement 3 messages prefixes [PUBLIC], [PRIVE], [INTERNE].

Categories disponibles: service_complaint | fraud_accusation | general_negative | product_complaint | other

Schema JSON strict:
{{
  "sentiment": "very_negative|negative|neutral|positive",
  "score": <float -1.0 a 1.0>,
  "category": "service_complaint|fraud_accusation|general_negative|product_complaint|other",
  "keywords_matched": [<mots-cles detectes>],
  "bad_buzz_suggestions": [
    "[PUBLIC] <reponse publique empathique courte>",
    "[PRIVE] <message prive pour collecte d'infos>",
    "[INTERNE] <consigne pour equipe support/risk>"
  ]
}}

Exemples de signaux negatifs a ne pas rater:
- Plainte de retrait/virement bloque, carte refusee, compte gele
- Accusations d'arnaque, frais caches, agios abusifs
- Frustration envers le service client ou agence
- Posts en Darija exprimant colere ou deception financiere (ex: "banka m3andha service", "floussi bloqui", "carte matat3melch")

Client surveille: {client_name}
Mots-cles de reference: {keywords_str}
Post a analyser: {post_text}
""".strip()


def _strip_markdown_fences(raw_text: str) -> str:
    text = raw_text.strip()
    # \s* (not \\s*) — match actual whitespace/newlines after the opening fence
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
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


async def call_groq(prompt: str, api_key: str, model: str) -> str:
    if not api_key:
        raise RuntimeError("Missing GROQ_API_KEY")

    # Disable Groq SDK automatic retries so provider fallback is handled by our own logic.
    client = AsyncGroq(api_key=api_key, max_retries=0)
    response = await client.chat.completions.create(
        model=model,
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


def _call_gemini_sync(prompt: str, api_key: str, model: str) -> str:
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY")

    genai.configure(api_key=api_key)
    model_obj = genai.GenerativeModel(model)
    generation_config = {
        "temperature": 0.1,
        "max_output_tokens": 400,
        "response_mime_type": "application/json",
    }

    try:
        response = model_obj.generate_content(prompt, generation_config=generation_config)
    except Exception:
        generation_config.pop("response_mime_type", None)
        response = model_obj.generate_content(prompt, generation_config=generation_config)

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


async def call_gemini(prompt: str, api_key: str, model: str) -> str:
    return await asyncio.to_thread(_call_gemini_sync, prompt, api_key, model)


async def call_cerebras(prompt: str, api_key: str, model: str) -> str:
    if not api_key:
        raise RuntimeError("Missing CEREBRAS_API_KEY")

    base_url = str(settings.cerebras_base_url or "https://api.cerebras.ai/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    base_payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return only one JSON object and nothing else."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }

    async with httpx.AsyncClient(timeout=25.0) as client:
        payload = {**base_payload, "response_format": {"type": "json_object"}}
        response = await client.post(endpoint, headers=headers, json=payload)

        if response.status_code == 400 and "response_format" in response.text.lower():
            response = await client.post(endpoint, headers=headers, json=base_payload)

        response.raise_for_status()
        body = response.json()

    choices = body.get("choices") or []
    if not choices:
        return ""

    content = (choices[0] or {}).get("message", {}).get("content", "")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)

    return str(content or "")


def _is_rate_limit_error(exc: Exception) -> bool:
    if isinstance(exc, RateLimitError):
        return True
    msg = str(exc).lower()
    return "429" in msg or "rate limit" in msg or "quota" in msg or "too many requests" in msg


async def _call_groq_with_key_rotation(prompt: str, keys: list[str], model: str) -> str:
    if not keys:
        raise RuntimeError("Missing GROQ_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_groq(prompt, key, model)
        except _GROQ_FALLBACK_EXCEPTIONS as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Groq key %s/%s model=%s failed (%s). Trying next Groq key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("Groq key %s/%s model=%s failed (%s).", index, len(keys), model, exc)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Groq key %s/%s model=%s error (%s). Trying next Groq key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("Groq key %s/%s model=%s error (%s).", index, len(keys), model, exc)

    raise last_error or RuntimeError(f"Groq failed with all configured keys for model={model}")


async def _call_gemini_with_key_rotation(prompt: str, keys: list[str], model: str) -> str:
    if not keys:
        raise RuntimeError("Missing GEMINI_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_gemini(prompt, key, model)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Gemini key %s/%s model=%s failed (%s). Trying next Gemini key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("Gemini key %s/%s model=%s failed (%s).", index, len(keys), model, exc)

    raise last_error or RuntimeError(f"Gemini failed with all configured keys for model={model}")


async def _call_cerebras_with_key_rotation(prompt: str, keys: list[str], model: str) -> str:
    if not keys:
        raise RuntimeError("Missing CEREBRAS_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_cerebras(prompt, key, model)
        except _CEREBRAS_FALLBACK_EXCEPTIONS as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Cerebras key %s/%s model=%s failed (%s). Trying next Cerebras key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("Cerebras key %s/%s model=%s failed (%s).", index, len(keys), model, exc)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "Cerebras key %s/%s model=%s error (%s). Trying next Cerebras key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("Cerebras key %s/%s model=%s error (%s).", index, len(keys), model, exc)

    raise last_error or RuntimeError(f"Cerebras failed with all configured keys for model={model}")


async def _call_groq_with_model_rotation(prompt: str, keys: list[str], models: list[str]) -> str:
    if not models:
        raise RuntimeError("No Groq models configured")

    last_error: Exception | None = None
    for index, model in enumerate(models, start=1):
        try:
            return await _call_groq_with_key_rotation(prompt, keys, model)
        except Exception as exc:
            last_error = exc
            if _is_rate_limit_error(exc):
                logger.warning(
                    "Groq model %s/%s (%s) rate-limited. %s",
                    index, len(models), model,
                    "Trying next model." if index < len(models) else "No more models.",
                )
            else:
                logger.warning(
                    "Groq model %s/%s (%s) failed (%s). %s",
                    index, len(models), model, exc,
                    "Trying next model." if index < len(models) else "No more models.",
                )

    raise last_error or RuntimeError("Groq failed with all configured models and keys")


async def _call_gemini_with_model_rotation(prompt: str, keys: list[str], models: list[str]) -> str:
    if not models:
        raise RuntimeError("No Gemini models configured")

    last_error: Exception | None = None
    for index, model in enumerate(models, start=1):
        try:
            return await _call_gemini_with_key_rotation(prompt, keys, model)
        except Exception as exc:
            last_error = exc
            if _is_rate_limit_error(exc):
                logger.warning(
                    "Gemini model %s/%s (%s) rate-limited. %s",
                    index, len(models), model,
                    "Trying next model." if index < len(models) else "No more models.",
                )
            else:
                logger.warning(
                    "Gemini model %s/%s (%s) failed (%s). %s",
                    index, len(models), model, exc,
                    "Trying next model." if index < len(models) else "No more models.",
                )

    raise last_error or RuntimeError("Gemini failed with all configured models and keys")


async def _call_cerebras_with_model_rotation(prompt: str, keys: list[str], models: list[str]) -> str:
    if not models:
        raise RuntimeError("No Cerebras models configured")

    last_error: Exception | None = None
    for index, model in enumerate(models, start=1):
        try:
            return await _call_cerebras_with_key_rotation(prompt, keys, model)
        except Exception as exc:
            last_error = exc
            if _is_rate_limit_error(exc):
                logger.warning(
                    "Cerebras model %s/%s (%s) rate-limited. %s",
                    index, len(models), model,
                    "Trying next model." if index < len(models) else "No more models.",
                )
            else:
                logger.warning(
                    "Cerebras model %s/%s (%s) failed (%s). %s",
                    index, len(models), model, exc,
                    "Trying next model." if index < len(models) else "No more models.",
                )

    raise last_error or RuntimeError("Cerebras failed with all configured models and keys")


async def _analyze_with_provider(
    provider: str, prompt: str, keys: list[str], models: list[str]
) -> dict[str, Any]:
    if provider == "cerebras":
        raw_result = await _call_cerebras_with_model_rotation(prompt, keys, models)
    elif provider == "groq":
        raw_result = await _call_groq_with_model_rotation(prompt, keys, models)
    elif provider == "gemini":
        raw_result = await _call_gemini_with_model_rotation(prompt, keys, models)
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
    cerebras_keys = _build_key_pool(settings.cerebras_api_key, settings.cerebras_api_keys)
    groq_models = list(settings.groq_models)
    gemini_models = list(settings.gemini_models)
    cerebras_models = list(settings.cerebras_models)
    provider_order = _PROVIDER_SEQUENCE

    provider_keys = {
        "cerebras": cerebras_keys,
        "gemini": gemini_keys,
        "groq": groq_keys,
    }
    provider_models = {
        "cerebras": cerebras_models,
        "gemini": gemini_models,
        "groq": groq_models,
    }

    provider_errors: dict[str, Exception] = {}

    for provider in provider_order:
        keys = provider_keys.get(provider, [])
        models = provider_models.get(provider, [])
        if not keys:
            provider_errors[provider] = RuntimeError(f"No {provider} API keys configured")
            logger.warning("Skipping %s because no API key is configured.", provider.capitalize())
            continue

        try:
            parsed = await _analyze_with_provider(provider, prompt, keys, models)
            break
        except Exception as exc:
            provider_errors[provider] = exc
            logger.warning("%s failed (%s). Trying next provider.", provider.capitalize(), exc)
    else:
        logger.error(
            "All LLM providers failed. Cerebras error: %s | Gemini error: %s | Groq error: %s",
            provider_errors.get("cerebras"),
            provider_errors.get("gemini"),
            provider_errors.get("groq"),
        )
        parsed = dict(_NEUTRAL_DEFAULT)

    if not parsed.get("keywords_matched"):
        parsed["keywords_matched"] = _match_keywords(post_text, keywords)

    return _normalize_result(parsed)

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

_OPENROUTER_FALLBACK_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.TransportError,
    httpx.HTTPStatusError,
)

_PROVIDER_SEQUENCE = ("cerebras", "gemini", "groq", "openrouter")


# ---------------------------------------------------------------------------
# Local pre-classification heuristic
# ---------------------------------------------------------------------------
_DARIJA_NEGATIVE_SIGNALS: frozenset[str] = frozenset({
    # Darija core complaints
    "bloqui", "mbloki", "makhdoum", "matat3melch", "matkhdemch",
    "ma3ndich", "m3andich", "m3ndich", "manajmch", "manajamch",
    "msab", "khasretha", "5sretha", "5ostni", "5estni",
    "floussi", "flusi",
    "sra9a", "sra9", "sre9", "sra9ba", "sariqa", "sarqa",
    "nahab", "nabh", "serqou", "serkou", "srekha",
    "kadhaba", "kedhba", "kidhba", "kazeb", "ghalat",
    "thayt", "tayhet", "tayha", "t7aylet",
    "bhim", "3eyb", "3ib", "khayeb", "khayba",
    "galou", "wa3dou", "mawa3fouch", "khelfou",
    "mrigel", "mrigla", "nharou",
    "klew", "klou", "yaklou", "yaklaw",
    "manich radi", "manich rdhi", "manrdhi",
    "mfalsem", "mfalsa", "fals",
    "7asra", "7asret", "7aserte",
    "tdayam", "tdeyem", "tdayyem",
    "mchklha", "mchouma", "hchouma",
    "khrota", "khrouta", "zelta",
    "gha9ra", "kh9er", "kh9ara",
    # French banking complaints
    "arnaque", "arnaquer", "voleur", "voleurs", "escroquerie", "escroc",
    "bloque", "refus", "refuse", "interdit", "gele", "suspendu",
    "frais abusifs", "agios abusifs", "ponction",
    "service nul", "service catastrophique", "honte", "scandale",
    "mensonge", "menti", "trompe", "tromperie",
    "nullissime", "inadmissible", "inacceptable",
    "plainte", "signalement",
    "pas rembourse", "pas credite",
    "frustration", "deception",
    # Arabic standard
    "\u0627\u062d\u062a\u064a\u0627\u0644", "\u0633\u0631\u0642\u0629", "\u0646\u0635\u0628", "\u063a\u0634", "\u062e\u062f\u0627\u0639",
    "\u0645\u062d\u0638\u0648\u0631", "\u0645\u062c\u0645\u062f", "\u0645\u0631\u0641\u0648\u0636", "\u0645\u0633\u0631\u0648\u0642",
    "\u0645\u0627\u062e\u062f\u062a\u0648\u0634", "\u0645\u0627\u0646\u062c\u0645\u062a\u0634",
    "\u062e\u0633\u0627\u0631\u0629", "\u0641\u0636\u064a\u062d\u0629", "\u0639\u064a\u0628", "\u062d\u0631\u0627\u0645",
    "\u0634\u0643\u0648\u0649", "\u0634\u0643\u0627\u0648\u0649", "\u062e\u062f\u0645\u0629 \u0633\u064a\u0626\u0629",
})

_PRE_CLASSIFY_ANCHOR_THRESHOLD = 1
_PRE_CLASSIFY_NEGATIVE_THRESHOLD = 1


def local_pre_classify(
    post_text: str,
    anchor_hits: int,
    strong_hits: int,
    weak_hits: int,
    keywords: list[str],
) -> "dict | None":
    """
    Deterministic classification for obvious cases.
    Returns a result dict if confident enough to skip LLM, or None.
    """
    lowered = post_text.lower()
    negative_hit = any(sig in lowered for sig in _DARIJA_NEGATIVE_SIGNALS)
    matched_kws = [kw for kw in keywords if kw.lower() in lowered]

    if anchor_hits >= _PRE_CLASSIFY_ANCHOR_THRESHOLD and negative_hit:
        return {
            "sentiment": "negative",
            "score": -0.70,
            "category": "general_negative",
            "keywords_matched": matched_kws,
            "bad_buzz_suggestions": [
                "[PUBLIC] Nous avons bien reçu votre message et prenons votre situation très au sérieux.",
                "[PRIVE] Pouvez-vous nous transmettre votre numéro de compte en message privé?",
                "[INTERNE] Escalader au service client — plainte potentielle détectée (pré-classification locale).",
            ],
        }

    if anchor_hits == 0 and strong_hits == 0 and weak_hits <= 1:
        return {
            "sentiment": "neutral",
            "score": 0.0,
            "category": "other",
            "keywords_matched": matched_kws,
            "bad_buzz_suggestions": [],
        }

    return None


# ---------------------------------------------------------------------------
# Batch LLM helpers
# ---------------------------------------------------------------------------
BATCH_SIZE = 4


def build_batch_prompt(
    posts: "list[tuple[str, str]]",
    client_name: str,
    keywords: list[str],
) -> str:
    """Build a prompt that asks the LLM to analyse N posts and return a JSON array."""
    safe_keywords = [kw.strip() for kw in keywords if kw and kw.strip()]
    keywords_str = ", ".join(safe_keywords)
    n = len(posts)
    enumerated = "\n\n".join(
        f"[POST {i + 1}]\n{text}" for i, (_, text) in enumerate(posts)
    )
    return f"""
Tu es un expert en e-reputation pour les institutions financieres tunisiennes.
Client surveille: {client_name}
Mots-cles de reference: {keywords_str}

Analyse CHACUN des {n} posts et retourne UNIQUEMENT un tableau JSON (array) de {n} objets dans le meme ordre.
Aucun markdown, aucun commentaire — seulement le tableau JSON brut.

Schema par objet:
{{"sentiment":"very_negative|negative|neutral|positive","score":<float -1.0 a 1.0>,"category":"service_complaint|fraud_accusation|general_negative|product_complaint|other","keywords_matched":[...],"bad_buzz_suggestions":["[PUBLIC] ...","[PRIVE] ...","[INTERNE] ..."]}}

Regles cles:
- negative/very_negative: plainte, frustration, arnaque, probleme bancaire.
- neutral: question neutre, information simple.
- Score precis, pas de 0.0 si une emotion est detectee.
- Inclure equivalents Darija/arabe dans keywords_matched.

Posts:
{enumerated}
""".strip()


def _parse_batch_response(raw: str, expected_count: int) -> "list[dict] | None":
    cleaned = _strip_markdown_fences(raw)
    if cleaned.startswith("{"):
        try:
            wrapper = json.loads(cleaned)
            for key in ("results", "posts", "analyses", "data"):
                if isinstance(wrapper.get(key), list):
                    cleaned = json.dumps(wrapper[key])
                    break
        except json.JSONDecodeError:
            pass
    array_match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not array_match:
        return None
    try:
        parsed = json.loads(array_match.group(0))
        if not isinstance(parsed, list) or len(parsed) != expected_count:
            return None
        return [_normalize_result(item) if isinstance(item, dict) else None for item in parsed]
    except json.JSONDecodeError:
        return None


async def analyze_posts_batch(
    posts: "list[tuple[str, str]]",
    client_name: str,
    keywords: list[str],
) -> "list[dict | None]":
    """
    Analyse multiple posts in a single LLM call.
    Returns list aligned with input — None per slot means 'batch failed, use fallback'.
    """
    if not posts:
        return []

    prompt = build_batch_prompt(posts, client_name, keywords)

    groq_keys = _build_key_pool(settings.groq_api_key, settings.groq_api_keys)
    gemini_keys = _build_key_pool(settings.gemini_api_key, settings.gemini_api_keys)
    cerebras_keys = _build_key_pool(settings.cerebras_api_key, settings.cerebras_api_keys)
    openrouter_keys = _build_key_pool(settings.openrouter_api_key, settings.openrouter_api_keys)

    rotation_map = {
        "cerebras": (_call_cerebras_with_model_rotation, cerebras_keys, list(settings.cerebras_models)),
        "gemini": (_call_gemini_with_model_rotation, gemini_keys, list(settings.gemini_models)),
        "groq": (_call_groq_with_model_rotation, groq_keys, list(settings.groq_models)),
        "openrouter": (_call_openrouter_with_model_rotation, openrouter_keys, list(settings.openrouter_models)),
    }
    key_map = {
        "cerebras": cerebras_keys, "gemini": gemini_keys,
        "groq": groq_keys, "openrouter": openrouter_keys,
    }

    for provider in _PROVIDER_SEQUENCE:
        if not key_map.get(provider):
            continue
        fn, keys, models = rotation_map[provider]
        try:
            raw_text = await fn(prompt, keys, models)
        except Exception as exc:
            logger.warning("Batch LLM %s failed: %s", provider, exc)
            continue
        parsed = _parse_batch_response(raw_text, len(posts))
        if parsed is not None:
            logger.info("Batch of %d posts analysed via %s.", len(posts), provider)
            return parsed
        logger.warning("Batch parse failed for %s, trying next provider.", provider)

    logger.warning("All batch LLM providers failed — %d posts need local fallback.", len(posts))
    return [None] * len(posts)


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


async def call_openrouter(prompt: str, api_key: str, model: str) -> str:
    if not api_key:
        raise RuntimeError("Missing OPENROUTER_API_KEY")

    base_url = str(settings.openrouter_base_url or "https://openrouter.ai/api/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/AgenticCoding/antigravity",
        "X-Title": "E-Reputation Watcher",
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


async def _call_openrouter_with_key_rotation(prompt: str, keys: list[str], model: str) -> str:
    if not keys:
        raise RuntimeError("Missing OPENROUTER_API_KEY")

    last_error: Exception | None = None
    for index, key in enumerate(keys, start=1):
        try:
            return await call_openrouter(prompt, key, model)
        except _OPENROUTER_FALLBACK_EXCEPTIONS as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "OpenRouter key %s/%s model=%s failed (%s). Trying next OpenRouter key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("OpenRouter key %s/%s model=%s failed (%s).", index, len(keys), model, exc)
        except Exception as exc:
            last_error = exc
            if index < len(keys):
                logger.warning(
                    "OpenRouter key %s/%s model=%s error (%s). Trying next OpenRouter key.",
                    index, len(keys), model, exc,
                )
            else:
                logger.warning("OpenRouter key %s/%s model=%s error (%s).", index, len(keys), model, exc)

    raise last_error or RuntimeError(f"OpenRouter failed with all configured keys for model={model}")


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


async def _call_openrouter_with_model_rotation(prompt: str, keys: list[str], models: list[str]) -> str:
    if not models:
        raise RuntimeError("No OpenRouter models configured")

    last_error: Exception | None = None
    for index, model in enumerate(models, start=1):
        try:
            return await _call_openrouter_with_key_rotation(prompt, keys, model)
        except Exception as exc:
            last_error = exc
            if _is_rate_limit_error(exc):
                logger.warning(
                    "OpenRouter model %s/%s (%s) rate-limited. %s",
                    index, len(models), model,
                    "Trying next model." if index < len(models) else "No more models.",
                )
            else:
                logger.warning(
                    "OpenRouter model %s/%s (%s) failed (%s). %s",
                    index, len(models), model, exc,
                    "Trying next model." if index < len(models) else "No more models.",
                )

    raise last_error or RuntimeError("OpenRouter failed with all configured models and keys")


async def _analyze_with_provider(
    provider: str, prompt: str, keys: list[str], models: list[str]
) -> dict[str, Any]:
    if provider == "cerebras":
        raw_result = await _call_cerebras_with_model_rotation(prompt, keys, models)
    elif provider == "groq":
        raw_result = await _call_groq_with_model_rotation(prompt, keys, models)
    elif provider == "gemini":
        raw_result = await _call_gemini_with_model_rotation(prompt, keys, models)
    elif provider == "openrouter":
        raw_result = await _call_openrouter_with_model_rotation(prompt, keys, models)
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
    openrouter_keys = _build_key_pool(settings.openrouter_api_key, settings.openrouter_api_keys)
    groq_models = list(settings.groq_models)
    gemini_models = list(settings.gemini_models)
    cerebras_models = list(settings.cerebras_models)
    openrouter_models = list(settings.openrouter_models)
    provider_order = _PROVIDER_SEQUENCE

    provider_keys = {
        "cerebras": cerebras_keys,
        "gemini": gemini_keys,
        "groq": groq_keys,
        "openrouter": openrouter_keys,
    }
    provider_models = {
        "cerebras": cerebras_models,
        "gemini": gemini_models,
        "groq": groq_models,
        "openrouter": openrouter_models,
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
            "All LLM providers failed. Cerebras error: %s | Gemini error: %s | Groq error: %s | OpenRouter error: %s",
            provider_errors.get("cerebras"),
            provider_errors.get("gemini"),
            provider_errors.get("groq"),
            provider_errors.get("openrouter"),
        )
        parsed = dict(_NEUTRAL_DEFAULT)

    if not parsed.get("keywords_matched"):
        parsed["keywords_matched"] = _match_keywords(post_text, keywords)

    return _normalize_result(parsed)

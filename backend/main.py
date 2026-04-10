from __future__ import annotations

import math
import logging
import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import llm
import mailer
import storage
from models import (
    AlertStatsResponse,
    AnalyzeRequest,
    AnalyzeResponse,
    BadBuzzItem,
    ExtensionStateResponse,
    ExtensionStateSyncRequest,
    GroupCreate,
    GroupUpdate,
    SentimentResult,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="E-Reputation Watcher Backend", version="1.0.0")

_SENTIMENT_SEVERITY = {
    "very_negative": 1.0,
    "negative": 0.7,
    "neutral": 0.2,
    "positive": 0.0,
}


def _get_cors_origins() -> list[str]:
    configured = os.getenv("BACKEND_CORS_ORIGINS", "").strip()
    if not configured:
        return ["*"]
    return [origin.strip() for origin in configured.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    storage.init_db()


def _compute_priority_score(sentiment: str, score: float, reactions: int, comments: int, shares: int) -> float:
    severity = _SENTIMENT_SEVERITY.get(sentiment, 0.0)
    score_severity = max(0.0, min(1.0, -score))
    sentiment_component = max(severity, score_severity)

    weighted_engagement = max(0, reactions) + (2 * max(0, comments)) + (3 * max(0, shares))
    engagement_component = min(1.0, math.log1p(weighted_engagement) / 8.0)

    # Recency is currently a constant boost; recency ranking is handled by created_at ordering.
    recency_component = 1.0

    priority = (
        (0.55 * sentiment_component)
        + (0.35 * engagement_component)
        + (0.10 * recency_component)
    )
    return round(max(0.0, min(1.0, priority)), 4)


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_posts(request: AnalyzeRequest) -> AnalyzeResponse:
    results: list[SentimentResult] = []
    alerts_sent = 0

    # Filter out already-processed posts before paying for any LLM calls.
    new_posts = [p for p in request.posts if not storage.alert_exists(p.id)]
    if not new_posts:
        return AnalyzeResponse(results=[], alerts_sent=0)

    # ------------------------------------------------------------------
    # Phase 1 — Local pre-classification (zero API calls)
    # Posts that are obviously negative (anchor + pejorative word) or
    # obviously low-signal (no anchor, no strong, ≤1 weak) are classified
    # immediately. Only ambiguous posts move to the LLM batch phase.
    # ------------------------------------------------------------------
    pre_classified: dict[str, dict] = {}
    llm_needed: list = []

    for post in new_posts:
        local_result = llm.local_pre_classify(
            post_text=post.text,
            anchor_hits=post.keyword_gate_anchor_hits,
            strong_hits=post.keyword_gate_strong_hits,
            weak_hits=post.keyword_gate_weak_hits,
            keywords=request.keywords,
        )
        if local_result is not None:
            pre_classified[post.id] = local_result
            logger.info("Post %s pre-classified locally as %s.", post.id, local_result["sentiment"])
        else:
            llm_needed.append(post)

    # ------------------------------------------------------------------
    # Phase 2 — Batched LLM analysis (4 posts per call)
    # ------------------------------------------------------------------
    llm_results: dict[str, dict] = {}

    for i in range(0, len(llm_needed), llm.BATCH_SIZE):
        chunk = llm_needed[i : i + llm.BATCH_SIZE]
        batch_input = [(p.id, p.text) for p in chunk]
        batch_output = await llm.analyze_posts_batch(
            posts=batch_input,
            client_name=request.client_name,
            keywords=request.keywords,
        )
        for post, sentiment_data in zip(chunk, batch_output):
            if sentiment_data is not None:
                llm_results[post.id] = sentiment_data
            else:
                # Batch failed for this post — fall back to local pre-classify
                # with relaxed thresholds (treat as 'needs review').
                fallback = llm.local_pre_classify(
                    post_text=post.text,
                    anchor_hits=max(post.keyword_gate_anchor_hits, 1),  # force through
                    strong_hits=post.keyword_gate_strong_hits,
                    weak_hits=post.keyword_gate_weak_hits,
                    keywords=request.keywords,
                ) or {"sentiment": "neutral", "score": 0.0, "category": "other",
                      "keywords_matched": [], "bad_buzz_suggestions": []}
                llm_results[post.id] = fallback
                logger.warning("Post %s fell back to local classification after batch failure.", post.id)

    # ------------------------------------------------------------------
    # Phase 3 — Persist + assemble results
    # ------------------------------------------------------------------
    all_sentiment: dict[str, dict] = {**pre_classified, **llm_results}

    for post in new_posts:
        sentiment_data = all_sentiment.get(post.id)
        if sentiment_data is None:
            continue

        llm_keywords = [
            str(item).strip()
            for item in sentiment_data.get("keywords_matched", [])
            if str(item).strip()
        ]
        local_keywords = [
            str(item).strip()
            for item in (post.keywords_matched_local or [])
            if str(item).strip()
        ]
        merged_keywords = list(dict.fromkeys([*local_keywords, *llm_keywords]))

        if not merged_keywords:
            continue

        sentiment = str(sentiment_data.get("sentiment", "neutral")).strip().lower()
        reactions_count = max(0, int(post.reactions_count or 0))
        comments_count = max(0, int(post.comments_count or 0))
        shares_count = max(0, int(post.shares_count or 0))
        engagement_total = reactions_count + comments_count + shares_count

        priority_score = _compute_priority_score(
            sentiment=sentiment,
            score=float(sentiment_data.get("score", 0.0)),
            reactions=reactions_count,
            comments=comments_count,
            shares=shares_count,
        )
        is_bad_buzz = sentiment in {"negative", "very_negative"} and priority_score >= 0.45

        result = SentimentResult(
            post_id=post.id,
            sentiment=sentiment,
            score=float(sentiment_data.get("score", 0.0)),
            category=str(sentiment_data.get("category", "other")),
            keywords_matched=merged_keywords,
            bad_buzz_suggestions=[
                str(item) for item in sentiment_data.get("bad_buzz_suggestions", [])
            ],
            should_alert=sentiment in {"negative", "very_negative"},
            priority_score=priority_score,
            engagement_total=engagement_total,
        )

        email_sent = False
        if result.should_alert:
            email_sent = mailer.send_alert(post, result, request.alert_email)
            if email_sent:
                alerts_sent += 1

        created_at = datetime.now(timezone.utc).isoformat()
        storage.save_alert(
            {
                "id": post.id,
                "post_text": post.text,
                "author": post.author,
                "post_url": post.post_url,
                "group_name": post.group_name,
                "group_url": post.group_url,
                "sentiment": result.sentiment,
                "score": result.score,
                "category": result.category,
                "keywords_matched": result.keywords_matched,
                "bad_buzz_suggestions": result.bad_buzz_suggestions,
                "reactions_count": reactions_count,
                "comments_count": comments_count,
                "shares_count": shares_count,
                "engagement_total": engagement_total,
                "priority_score": priority_score,
                "is_bad_buzz": is_bad_buzz,
                "installation_id": request.installation_id,
                "source_post_timestamp": post.timestamp,
                "email_sent": 1 if email_sent else 0,
                "created_at": created_at,
            }
        )

        results.append(result)

    return AnalyzeResponse(results=results, alerts_sent=alerts_sent)


@app.get("/history")
async def get_history(
    limit: int = Query(50, ge=1, le=500),
    sentiment: str | None = Query(None),
    only_bad_buzz: bool = Query(False),
) -> list[dict]:
    return storage.get_recent_alerts(limit=limit, sentiment=sentiment, only_bad_buzz=only_bad_buzz)


@app.get("/badbuzz", response_model=list[BadBuzzItem])
async def get_badbuzz(limit: int = Query(50, ge=1, le=500)) -> list[dict]:
    return storage.get_bad_buzz(limit=limit)


@app.get("/groups")
async def get_groups(include_disabled: bool = Query(True)) -> list[dict]:
    return storage.list_groups(include_disabled=include_disabled)


@app.post("/groups")
async def create_group(payload: GroupCreate) -> dict:
    try:
        return storage.create_group(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/groups/{group_id}")
async def update_group(group_id: int, payload: GroupUpdate) -> dict:
    try:
        updated = storage.update_group(group_id, payload.model_dump(exclude_none=True))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    return updated


@app.delete("/groups/{group_id}")
async def delete_group(group_id: int) -> dict[str, bool]:
    deleted = storage.delete_group(group_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"ok": True}


@app.post("/extension/sync-state", response_model=ExtensionStateResponse)
async def sync_extension_state(payload: ExtensionStateSyncRequest) -> dict:
    try:
        return storage.sync_extension_state(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/extension/state", response_model=ExtensionStateResponse)
async def get_extension_state(installation_id: str | None = Query(None)) -> dict:
    state = storage.get_extension_state(installation_id=installation_id)
    if not state:
        raise HTTPException(status_code=404, detail="No extension state synced yet")
    return state


@app.get("/keywords")
async def get_keywords() -> list[dict]:
    return storage.get_keywords_view()


@app.get("/stats", response_model=AlertStatsResponse)
async def get_stats() -> dict:
    return storage.get_alert_stats()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "1.0.0"}

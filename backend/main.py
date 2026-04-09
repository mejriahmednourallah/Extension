from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import llm
import mailer
import storage
from models import AnalyzeRequest, AnalyzeResponse, SentimentResult

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="E-Reputation Watcher Backend", version="1.0.0")


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


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_posts(request: AnalyzeRequest) -> AnalyzeResponse:
    results: list[SentimentResult] = []
    alerts_sent = 0

    for post in request.posts:
        if storage.alert_exists(post.id):
            continue

        sentiment_data = await llm.analyze_post(
            post_text=post.text,
            client_name=request.client_name,
            keywords=request.keywords,
        )

        sentiment = str(sentiment_data.get("sentiment", "neutral")).strip().lower()
        result = SentimentResult(
            post_id=post.id,
            sentiment=sentiment,
            score=float(sentiment_data.get("score", 0.0)),
            category=str(sentiment_data.get("category", "other")),
            keywords_matched=[str(item) for item in sentiment_data.get("keywords_matched", [])],
            bad_buzz_suggestions=[
                str(item) for item in sentiment_data.get("bad_buzz_suggestions", [])
            ],
            should_alert=sentiment in {"negative", "very_negative"},
        )

        email_sent = False
        if result.should_alert:
            email_sent = mailer.send_alert(post, result, request.alert_email)
            if email_sent:
                alerts_sent += 1

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
                "email_sent": 1 if email_sent else 0,
                "created_at": post.timestamp,
            }
        )

        results.append(result)

    return AnalyzeResponse(results=results, alerts_sent=alerts_sent)


@app.get("/history")
async def get_history() -> list[dict]:
    return storage.get_recent_alerts(50)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "1.0.0"}

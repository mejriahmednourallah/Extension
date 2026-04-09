from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "alerts.db"
_DB_LOCK = Lock()


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _DB_LOCK:
        with _get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS alerts (
                    id TEXT PRIMARY KEY,
                    post_text TEXT,
                    author TEXT,
                    post_url TEXT,
                    group_name TEXT,
                    group_url TEXT,
                    sentiment TEXT,
                    score REAL,
                    category TEXT,
                    keywords_matched TEXT,
                    bad_buzz_suggestions TEXT,
                    email_sent INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now'))
                );
                """
            )
            conn.commit()


def alert_exists(post_id: str) -> bool:
    if not post_id:
        return False

    init_db()
    with _DB_LOCK:
        with _get_connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM alerts WHERE id = ? LIMIT 1",
                (post_id,),
            ).fetchone()
    return row is not None


def save_alert(alert_data: dict[str, Any]) -> None:
    init_db()

    keywords_json = json.dumps(alert_data.get("keywords_matched", []), ensure_ascii=False)
    suggestions_json = json.dumps(alert_data.get("bad_buzz_suggestions", []), ensure_ascii=False)

    record = (
        alert_data.get("id", ""),
        alert_data.get("post_text") or alert_data.get("text", ""),
        alert_data.get("author", ""),
        alert_data.get("post_url", ""),
        alert_data.get("group_name", ""),
        alert_data.get("group_url", ""),
        alert_data.get("sentiment", "neutral"),
        float(alert_data.get("score", 0.0)),
        alert_data.get("category", "other"),
        keywords_json,
        suggestions_json,
        1 if alert_data.get("email_sent", 0) else 0,
        alert_data.get("created_at"),
    )

    with _DB_LOCK:
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO alerts (
                    id,
                    post_text,
                    author,
                    post_url,
                    group_name,
                    group_url,
                    sentiment,
                    score,
                    category,
                    keywords_matched,
                    bad_buzz_suggestions,
                    email_sent,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
                """,
                record,
            )
            conn.commit()


def _parse_json_array(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def get_recent_alerts(limit: int = 50) -> list[dict[str, Any]]:
    init_db()

    capped_limit = max(1, min(limit, 500))

    with _DB_LOCK:
        with _get_connection() as conn:
            rows = conn.execute(
                """
                SELECT
                    id,
                    post_text,
                    author,
                    post_url,
                    group_name,
                    group_url,
                    sentiment,
                    score,
                    category,
                    keywords_matched,
                    bad_buzz_suggestions,
                    email_sent,
                    created_at
                FROM alerts
                ORDER BY datetime(created_at) DESC
                LIMIT ?
                """,
                (capped_limit,),
            ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        results.append(
            {
                "id": row["id"],
                "post_text": row["post_text"],
                "author": row["author"],
                "post_url": row["post_url"],
                "group_name": row["group_name"],
                "group_url": row["group_url"],
                "sentiment": row["sentiment"],
                "score": float(row["score"] or 0.0),
                "category": row["category"],
                "keywords_matched": _parse_json_array(row["keywords_matched"]),
                "bad_buzz_suggestions": _parse_json_array(row["bad_buzz_suggestions"]),
                "email_sent": bool(row["email_sent"]),
                "created_at": row["created_at"],
            }
        )

    return results

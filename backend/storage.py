from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "alerts.db"
_DB_LOCK = Lock()
_NEGATIVE_SENTIMENTS = {"negative", "very_negative"}


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _get_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return value != 0
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off", ""}:
        return False
    return default


def _detect_language_bucket(text: str | None) -> str:
    value = str(text or "").strip().lower()
    if not value:
        return "mixte"

    has_arabic = bool(re.search(r"[\u0600-\u06FF]", value))
    has_latin = bool(re.search(r"[a-zàâçéèêëîïôûùüÿñæœ]", value, flags=re.IGNORECASE))

    darija_markers = {
        "برشة",
        "برشا",
        "بزاف",
        "شنية",
        "علاش",
        "خاطر",
        "باش",
        "ديما",
        "ياسر",
        "barsha",
        "brcha",
        "barcha",
        "3lech",
        "chnowa",
        "chnia",
        "khater",
        "bech",
        "yesser",
        "barcha",
    }

    has_darija_marker = any(marker in value for marker in darija_markers)

    if has_arabic and has_latin:
        return "mixte"
    if has_darija_marker:
        return "darija"
    if has_arabic:
        return "arabic"
    if has_latin:
        return "french"
    return "mixte"


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
                    reactions_count INTEGER DEFAULT 0,
                    comments_count INTEGER DEFAULT 0,
                    shares_count INTEGER DEFAULT 0,
                    engagement_total INTEGER DEFAULT 0,
                    priority_score REAL DEFAULT 0,
                    is_bad_buzz INTEGER DEFAULT 0,
                    installation_id TEXT,
                    source_post_timestamp TEXT,
                    email_sent INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now'))
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    group_url TEXT NOT NULL UNIQUE,
                    category TEXT DEFAULT 'marque',
                    enabled INTEGER DEFAULT 1,
                    scan_interval_minutes INTEGER DEFAULT 15,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS extension_state (
                    installation_id TEXT PRIMARY KEY,
                    client_name TEXT,
                    alert_email TEXT,
                    auto_scan INTEGER DEFAULT 1,
                    keywords_json TEXT,
                    synced_at TEXT DEFAULT (datetime('now'))
                );
                """
            )

            columns = _get_columns(conn, "alerts")
            migrations: dict[str, str] = {
                "reactions_count": "INTEGER DEFAULT 0",
                "comments_count": "INTEGER DEFAULT 0",
                "shares_count": "INTEGER DEFAULT 0",
                "engagement_total": "INTEGER DEFAULT 0",
                "priority_score": "REAL DEFAULT 0",
                "is_bad_buzz": "INTEGER DEFAULT 0",
                "installation_id": "TEXT",
                "source_post_timestamp": "TEXT",
            }
            for column, definition in migrations.items():
                if column not in columns:
                    conn.execute(f"ALTER TABLE alerts ADD COLUMN {column} {definition}")

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

    reactions_count = max(0, _to_int(alert_data.get("reactions_count", 0)))
    comments_count = max(0, _to_int(alert_data.get("comments_count", 0)))
    shares_count = max(0, _to_int(alert_data.get("shares_count", 0)))
    engagement_total = max(
        0,
        _to_int(
            alert_data.get(
                "engagement_total",
                reactions_count + comments_count + shares_count,
            )
        ),
    )

    sentiment = str(alert_data.get("sentiment", "neutral")).strip().lower()
    is_bad_buzz = _to_bool(alert_data.get("is_bad_buzz"), sentiment in _NEGATIVE_SENTIMENTS)

    record = (
        alert_data.get("id", ""),
        alert_data.get("post_text") or alert_data.get("text", ""),
        alert_data.get("author", ""),
        alert_data.get("post_url", ""),
        alert_data.get("group_name", ""),
        alert_data.get("group_url", ""),
        sentiment,
        _to_float(alert_data.get("score", 0.0)),
        alert_data.get("category", "other"),
        keywords_json,
        suggestions_json,
        reactions_count,
        comments_count,
        shares_count,
        engagement_total,
        _to_float(alert_data.get("priority_score", 0.0)),
        1 if is_bad_buzz else 0,
        str(alert_data.get("installation_id", "") or "").strip() or None,
        alert_data.get("source_post_timestamp"),
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
                    reactions_count,
                    comments_count,
                    shares_count,
                    engagement_total,
                    priority_score,
                    is_bad_buzz,
                    installation_id,
                    source_post_timestamp,
                    email_sent,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
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


def get_recent_alerts(
    limit: int = 50,
    sentiment: str | None = None,
    only_bad_buzz: bool = False,
) -> list[dict[str, Any]]:
    init_db()

    capped_limit = max(1, min(limit, 500))

    where_clauses: list[str] = []
    params: list[Any] = []

    if sentiment:
        where_clauses.append("LOWER(sentiment) = ?")
        params.append(str(sentiment).strip().lower())

    if only_bad_buzz:
        where_clauses.append("is_bad_buzz = 1")

    where_sql = ""
    if where_clauses:
        where_sql = f"WHERE {' AND '.join(where_clauses)}"

    params.append(capped_limit)

    with _DB_LOCK:
        with _get_connection() as conn:
            rows = conn.execute(
                f"""
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
                    reactions_count,
                    comments_count,
                    shares_count,
                    engagement_total,
                    priority_score,
                    is_bad_buzz,
                    installation_id,
                    source_post_timestamp,
                    email_sent,
                    created_at
                FROM alerts
                {where_sql}
                ORDER BY datetime(created_at) DESC
                LIMIT ?
                """,
                params,
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
                "reactions_count": int(row["reactions_count"] or 0),
                "comments_count": int(row["comments_count"] or 0),
                "shares_count": int(row["shares_count"] or 0),
                "engagement_total": int(row["engagement_total"] or 0),
                "priority_score": float(row["priority_score"] or 0.0),
                "is_bad_buzz": bool(row["is_bad_buzz"]),
                "installation_id": row["installation_id"],
                "source_post_timestamp": row["source_post_timestamp"],
                "email_sent": bool(row["email_sent"]),
                "created_at": row["created_at"],
            }
        )

    return results


def get_bad_buzz(limit: int = 50) -> list[dict[str, Any]]:
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
                    reactions_count,
                    comments_count,
                    shares_count,
                    engagement_total,
                    priority_score,
                    created_at
                FROM alerts
                                WHERE is_bad_buzz = 1
                                     OR (
                                                sentiment IN ('negative', 'very_negative')
                                                AND COALESCE(priority_score, 0) >= 0.45
                                            )
                ORDER BY priority_score DESC, engagement_total DESC, datetime(created_at) DESC
                LIMIT ?
                """,
                (capped_limit,),
            ).fetchall()

    return [
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
            "reactions_count": int(row["reactions_count"] or 0),
            "comments_count": int(row["comments_count"] or 0),
            "shares_count": int(row["shares_count"] or 0),
            "engagement_total": int(row["engagement_total"] or 0),
            "priority_score": float(row["priority_score"] or 0.0),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def list_groups(include_disabled: bool = True) -> list[dict[str, Any]]:
    init_db()
    where_sql = "" if include_disabled else "WHERE enabled = 1"

    with _DB_LOCK:
        with _get_connection() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    id,
                    name,
                    group_url,
                    category,
                    enabled,
                    scan_interval_minutes,
                    created_at,
                    updated_at
                FROM groups
                {where_sql}
                ORDER BY datetime(updated_at) DESC, id DESC
                """
            ).fetchall()

    return [
        {
            "id": int(row["id"]),
            "name": row["name"],
            "group_url": row["group_url"],
            "url": row["group_url"],
            "category": row["category"] or "marque",
            "enabled": bool(row["enabled"]),
            "scan_interval_minutes": int(row["scan_interval_minutes"] or 15),
            "interval": int(row["scan_interval_minutes"] or 15),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def create_group(data: dict[str, Any]) -> dict[str, Any]:
    init_db()

    group_url = str(data.get("group_url") or data.get("url") or "").strip()
    group = {
        "name": str(data.get("name") or "").strip() or "Unnamed Group",
        "group_url": group_url,
        "category": str(data.get("category") or "marque").strip() or "marque",
        "enabled": 1 if _to_bool(data.get("enabled"), True) else 0,
        "scan_interval_minutes": max(1, _to_int(data.get("scan_interval_minutes") or data.get("interval") or 15, 15)),
    }

    if not group["group_url"]:
        raise ValueError("group_url is required")

    with _DB_LOCK:
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO groups (name, group_url, category, enabled, scan_interval_minutes, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    group["name"],
                    group["group_url"],
                    group["category"],
                    group["enabled"],
                    group["scan_interval_minutes"],
                ),
            )
            row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
            conn.commit()

    created = get_group_by_id(int(row["id"]))
    if not created:
        raise ValueError("Failed to create group")
    return created


def get_group_by_id(group_id: int) -> dict[str, Any] | None:
    init_db()
    with _DB_LOCK:
        with _get_connection() as conn:
            row = conn.execute(
                """
                SELECT
                    id,
                    name,
                    group_url,
                    category,
                    enabled,
                    scan_interval_minutes,
                    created_at,
                    updated_at
                FROM groups
                WHERE id = ?
                LIMIT 1
                """,
                (group_id,),
            ).fetchone()

    if not row:
        return None

    return {
        "id": int(row["id"]),
        "name": row["name"],
        "group_url": row["group_url"],
        "url": row["group_url"],
        "category": row["category"] or "marque",
        "enabled": bool(row["enabled"]),
        "scan_interval_minutes": int(row["scan_interval_minutes"] or 15),
        "interval": int(row["scan_interval_minutes"] or 15),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def update_group(group_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
    init_db()
    existing = get_group_by_id(group_id)
    if not existing:
        return None

    merged = {
        "name": str(updates.get("name", existing["name"])) or existing["name"],
        "group_url": str(
            updates.get("group_url", updates.get("url", existing["group_url"]))
        ).strip()
        or existing["group_url"],
        "category": str(updates.get("category", existing["category"])) or existing["category"],
        "enabled": 1
        if _to_bool(updates.get("enabled"), bool(existing["enabled"]))
        else 0,
        "scan_interval_minutes": max(
            1,
            _to_int(
                updates.get(
                    "scan_interval_minutes",
                    updates.get("interval", existing["scan_interval_minutes"]),
                ),
                int(existing["scan_interval_minutes"]),
            ),
        ),
    }

    with _DB_LOCK:
        with _get_connection() as conn:
            conn.execute(
                """
                UPDATE groups
                SET
                    name = ?,
                    group_url = ?,
                    category = ?,
                    enabled = ?,
                    scan_interval_minutes = ?,
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (
                    merged["name"],
                    merged["group_url"],
                    merged["category"],
                    merged["enabled"],
                    merged["scan_interval_minutes"],
                    group_id,
                ),
            )
            conn.commit()

    return get_group_by_id(group_id)


def delete_group(group_id: int) -> bool:
    init_db()
    with _DB_LOCK:
        with _get_connection() as conn:
            result = conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
            conn.commit()
    return result.rowcount > 0


def sync_extension_state(data: dict[str, Any]) -> dict[str, Any]:
    init_db()

    installation_id = str(data.get("installation_id") or "").strip()
    if not installation_id:
        raise ValueError("installation_id is required")

    keywords_json = json.dumps(data.get("keywords", []), ensure_ascii=False)

    with _DB_LOCK:
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO extension_state (
                    installation_id,
                    client_name,
                    alert_email,
                    auto_scan,
                    keywords_json,
                    synced_at
                ) VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(installation_id) DO UPDATE SET
                    client_name = excluded.client_name,
                    alert_email = excluded.alert_email,
                    auto_scan = excluded.auto_scan,
                    keywords_json = excluded.keywords_json,
                    synced_at = datetime('now')
                """,
                (
                    installation_id,
                    str(data.get("client_name") or ""),
                    str(data.get("alert_email") or ""),
                    1 if _to_bool(data.get("auto_scan"), True) else 0,
                    keywords_json,
                ),
            )
            conn.commit()

    state = get_extension_state(installation_id)
    if not state:
        raise ValueError("Failed to sync extension state")
    return state


def get_extension_state(installation_id: str | None = None) -> dict[str, Any] | None:
    init_db()

    query = """
        SELECT
            installation_id,
            client_name,
            alert_email,
            auto_scan,
            keywords_json,
            synced_at
        FROM extension_state
    """
    params: tuple[Any, ...] = ()
    if installation_id:
        query += " WHERE installation_id = ? "
        params = (installation_id,)
    query += " ORDER BY datetime(synced_at) DESC LIMIT 1 "

    with _DB_LOCK:
        with _get_connection() as conn:
            row = conn.execute(query, params).fetchone()

    if not row:
        return None

    return {
        "installation_id": row["installation_id"],
        "client_name": row["client_name"] or "",
        "alert_email": row["alert_email"] or "",
        "auto_scan": bool(row["auto_scan"]),
        "keywords": _parse_json_array(row["keywords_json"]),
        "synced_at": row["synced_at"],
    }


def _classify_keyword(keyword: str) -> str:
    lowered = keyword.lower()
    negative_markers = [
        "arnaque",
        "fraude",
        "scam",
        "vol",
        "risque",
        "شكوى",
        "سرقة",
    ]
    service_markers = ["service", "client", "support", "agence", "خدمة", "الحرفاء"]
    product_markers = ["carte", "compte", "credit", "pret", "virement", "قرض", "بطاقة"]

    if any(marker in lowered for marker in negative_markers):
        return "negatif"
    if any(marker in lowered for marker in service_markers):
        return "services"
    if any(marker in lowered for marker in product_markers):
        return "produits"
    return "marque"


def get_keywords_view() -> list[dict[str, Any]]:
    state = get_extension_state()
    if not state:
        return []

    keywords = state.get("keywords", [])
    items: list[dict[str, Any]] = []
    for index, keyword in enumerate(keywords, start=1):
        normalized = str(keyword or "").strip()
        if not normalized:
            continue
        items.append(
            {
                "id": f"kw-{index}",
                "keyword": normalized,
                "category": _classify_keyword(normalized),
            }
        )
    return items


def get_alert_stats() -> dict[str, Any]:
    init_db()

    with _DB_LOCK:
        with _get_connection() as conn:
            total_posts = int(conn.execute("SELECT COUNT(*) AS c FROM alerts").fetchone()["c"])

            total_posts_today = int(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM alerts WHERE date(created_at) = date('now')"
                ).fetchone()["c"]
            )

            alerts_today = int(
                conn.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM alerts
                    WHERE date(created_at) = date('now')
                      AND sentiment IN ('negative', 'very_negative')
                    """
                ).fetchone()["c"]
            )

            groups_active_count = int(
                conn.execute("SELECT COUNT(*) AS c FROM groups WHERE enabled = 1").fetchone()["c"]
            )

            avg_score_24h = float(
                conn.execute(
                    """
                    SELECT COALESCE(AVG(score), 0) AS avg_score
                    FROM alerts
                    WHERE datetime(created_at) >= datetime('now', '-1 day')
                    """
                ).fetchone()["avg_score"]
                or 0.0
            )

            sentiment_rows = conn.execute(
                """
                SELECT sentiment, COUNT(*) AS c
                FROM alerts
                WHERE datetime(created_at) >= datetime('now', '-1 day')
                GROUP BY sentiment
                """
            ).fetchall()

            daily_rows = conn.execute(
                """
                SELECT date(created_at) AS day, sentiment, COUNT(*) AS c
                FROM alerts
                WHERE datetime(created_at) >= datetime('now', '-6 day')
                GROUP BY day, sentiment
                ORDER BY day ASC
                """
            ).fetchall()

            language_rows = conn.execute(
                """
                SELECT post_text
                FROM alerts
                WHERE datetime(created_at) >= datetime('now', '-1 day')
                """
            ).fetchall()

            last_scan_at = conn.execute("SELECT MAX(created_at) AS max_created FROM alerts").fetchone()[
                "max_created"
            ]

    sentiment_counts_24h = {
        "very_negative": 0,
        "negative": 0,
        "neutral": 0,
        "positive": 0,
    }
    for row in sentiment_rows:
        key = str(row["sentiment"] or "").strip().lower()
        if key in sentiment_counts_24h:
            sentiment_counts_24h[key] = int(row["c"])

    daily_map: dict[str, dict[str, Any]] = {}
    for row in daily_rows:
        day = str(row["day"])
        if day not in daily_map:
            daily_map[day] = {
                "day": day,
                "very_negative": 0,
                "negative": 0,
                "neutral": 0,
                "positive": 0,
            }
        sentiment = str(row["sentiment"] or "").strip().lower()
        if sentiment in daily_map[day]:
            daily_map[day][sentiment] = int(row["c"])

    daily_sentiment_7d = list(daily_map.values())

    language_distribution_24h = {
        "darija": 0,
        "french": 0,
        "arabic": 0,
        "mixte": 0,
    }

    for row in language_rows:
        bucket = _detect_language_bucket(row["post_text"])
        language_distribution_24h[bucket] = int(language_distribution_24h.get(bucket, 0)) + 1

    return {
        "total_posts": total_posts,
        "total_posts_today": total_posts_today,
        "alerts_today": alerts_today,
        "groups_active_count": groups_active_count,
        "avg_score_24h": avg_score_24h,
        "sentiment_counts_24h": sentiment_counts_24h,
        "language_distribution_24h": language_distribution_24h,
        "daily_sentiment_7d": daily_sentiment_7d,
        "last_scan_at": last_scan_at,
    }

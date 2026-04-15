from __future__ import annotations

import html
import logging
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

from config import settings

logger = logging.getLogger(__name__)

_COOLDOWN_SECONDS = 5 * 60
_last_sent_at_by_post_id: dict[str, float] = {}
_NEGATIVE_SENTIMENTS = {"negative", "very_negative"}
_SMTP_NETWORK_BACKOFF_SECONDS = 10 * 60
_SMTP_NETWORK_ERRNOS = {101, 110, 111, 113}
_smtp_blocked_until = 0.0
_last_smtp_skip_log_at = 0.0


def _get_value(payload: Any, key: str, default: Any = "") -> Any:
    if isinstance(payload, dict):
        return payload.get(key, default)
    return getattr(payload, key, default)


def _can_send(post_id: str) -> bool:
    now = time.time()
    previous = _last_sent_at_by_post_id.get(post_id, 0.0)
    if now - previous < _COOLDOWN_SECONDS:
        return False
    return True


def _severity_label(sentiment: str) -> str:
    if sentiment == "very_negative":
        return "Tres negatif"
    if sentiment == "negative":
        return "Negatif"
    return sentiment or "Neutral"


def _severity_color(sentiment: str) -> str:
    if sentiment == "very_negative":
        return "#e53e3e"
    if sentiment == "negative":
        return "#f6ad55"
    return "#a0aec0"


def send_alert(post: Any, result: Any, alert_email: str) -> bool:
    global _smtp_blocked_until
    global _last_smtp_skip_log_at

    sentiment = str(_get_value(result, "sentiment", "neutral")).lower().strip()
    if sentiment not in _NEGATIVE_SENTIMENTS:
        return False

    post_id = str(_get_value(post, "id", "") or _get_value(result, "post_id", "")).strip()
    if not post_id:
        logger.warning("Skipping email alert because post_id is missing")
        return False

    if not alert_email:
        logger.warning("Skipping email alert because destination email is empty")
        return False

    if not _can_send(post_id):
        logger.info("Skipping email for post_id=%s due to cooldown", post_id)
        return False

    if not settings.smtp_host or not settings.smtp_port:
        logger.warning("Skipping email alert because SMTP configuration is incomplete")
        return False

    sender = settings.alert_email_from or settings.smtp_user
    if not sender:
        logger.warning("Skipping email alert because sender email is not configured")
        return False

    now = time.time()
    if _smtp_blocked_until > now:
        if now - _last_smtp_skip_log_at >= 60:
            logger.warning(
                "Skipping email sends temporarily because SMTP network is unreachable (cooldown active for %ss).",
                int(_smtp_blocked_until - now),
            )
            _last_smtp_skip_log_at = now
        return False

    suggestions = _get_value(result, "bad_buzz_suggestions", [])
    if not isinstance(suggestions, list):
        suggestions = []

    author = html.escape(str(_get_value(post, "author", "Unknown")))
    group_name = html.escape(str(_get_value(post, "group_name", "Unknown group")))
    post_text = html.escape(str(_get_value(post, "text", "")))
    post_url = html.escape(str(_get_value(post, "post_url", "")))
    post_time = html.escape(str(_get_value(post, "timestamp", "")))

    suggestion_items = "".join(
        f"<li>{html.escape(str(item))}</li>" for item in suggestions[:3]
    )

    severity_label = _severity_label(sentiment)
    severity_color = _severity_color(sentiment)
    subject = f"[E-Reputation] {severity_label} detecte - {group_name}"

    body_html = f"""
    <html>
      <body style=\"font-family: Arial, sans-serif; line-height: 1.5; color: #1a202c;\">
        <div style=\"display: inline-block; padding: 6px 10px; border-radius: 8px; background: {severity_color}; color: white; font-weight: bold;\">
          {severity_label}
        </div>
        <h2 style=\"margin-top: 16px;\">Alerte E-Reputation</h2>
        <p><strong>Auteur:</strong> {author}</p>
        <p><strong>Groupe:</strong> {group_name}</p>
        <p><strong>Heure:</strong> {post_time}</p>
        <blockquote style=\"border-left: 4px solid #e2e8f0; margin: 16px 0; padding: 8px 12px; background: #f7fafc;\">
          {post_text}
        </blockquote>
        <p>
          <a href=\"{post_url}\" style=\"display: inline-block; padding: 10px 14px; background: #2b6cb0; color: #ffffff; text-decoration: none; border-radius: 6px;\">
            Voir le post
          </a>
        </p>
        <h3>Suggestions de reponse</h3>
        <ol>{suggestion_items}</ol>
        <hr />
        <p style=\"font-size: 12px; color: #718096;\">Alerte generee par E-Reputation Watcher POC</p>
      </body>
    </html>
    """.strip()

    message = MIMEMultipart("alternative")
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = alert_email
    message.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=25) as server:
            server.starttls()
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            server.sendmail(sender, [alert_email], message.as_string())

        _last_sent_at_by_post_id[post_id] = time.time()
        return True
    except Exception as exc:
        err_no = getattr(exc, "errno", None)
        if isinstance(exc, OSError) and err_no in _SMTP_NETWORK_ERRNOS:
            _smtp_blocked_until = time.time() + _SMTP_NETWORK_BACKOFF_SECONDS
            logger.warning(
                "SMTP network unreachable for post_id=%s (errno=%s). Pausing email sends for %ss.",
                post_id,
                err_no,
                _SMTP_NETWORK_BACKOFF_SECONDS,
            )
        else:
            logger.error("Failed to send email alert for post_id=%s: %s", post_id, exc)
        return False

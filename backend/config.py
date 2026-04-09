from dataclasses import dataclass
from pathlib import Path
import os
import re

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"

# Load workspace-level .env first, then any environment-level overrides.
load_dotenv(ENV_FILE)
load_dotenv()


def _read_int_env(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _read_list_env(name: str) -> tuple[str, ...]:
    value = os.getenv(name, "").strip()
    if not value:
        return ()

    items = [item.strip() for item in re.split(r"[,;\n]", value) if item.strip()]
    if not items:
        return ()

    # Keep order while deduplicating.
    return tuple(dict.fromkeys(items))


@dataclass(frozen=True)
class Settings:
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    groq_api_keys: tuple[str, ...] = _read_list_env("GROQ_API_KEYS")
    gemini_api_keys: tuple[str, ...] = _read_list_env("GEMINI_API_KEYS")
    groq_model: str = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    gemini_model: str = os.getenv("GEMINI_MODEL", "models/gemma-3-1b-it")
    smtp_host: str = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port: int = _read_int_env("SMTP_PORT", 587)
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    alert_email_from: str = os.getenv("ALERT_EMAIL_FROM", "")


settings = Settings()

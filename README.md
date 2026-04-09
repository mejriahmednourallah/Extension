# E-Reputation Facebook POC

Local proof-of-concept for monitoring Facebook group posts and detecting negative e-reputation signals.

## Why DOM scraping (not Graph API)

For this POC, Graph API is not used because closed/private group post content is not practically accessible without lengthy app review and explicit admin authorization. This solution reads what a real logged-in member sees in the live Facebook DOM.

## Stack

- Chrome Extension (Manifest V3)
- FastAPI backend (localhost:8000)
- Groq (primary) with Gemini Flash fallback
- SQLite persistence
- SMTP email alerts

## Repository Structure

- extension/
  - manifest.json
  - content.js
  - background.js
  - popup.html
  - popup.js
  - popup.css
  - icons/
- backend/
  - main.py
  - llm.py
  - mailer.py
  - models.py
  - storage.py
  - config.py
  - requirements.txt
- .env.example
- run.sh
- run-all.ps1

## One Command (Windows)

From PowerShell at repository root:

```powershell
./run-all.ps1
```

What it does:

- Creates .venv if missing
- Installs backend dependencies
- Starts FastAPI backend on port 8000
- Waits for health endpoint
- Opens chrome://extensions/ and Facebook groups page
- Opens extension folder in Explorer

Useful flags:

```powershell
./run-all.ps1 -SkipInstall
./run-all.ps1 -SkipBrowser
./run-all.ps1 -Foreground
```

If dependency installation fails, the script now stops immediately with an explicit error instead of trying to continue with a broken environment.

## Quick Start

1. Clone and configure environment

```bash
git clone <repo-url>
cd ereputation-poc
cp .env.example .env
```

Fill in at least:

- GROQ_API_KEY
- GEMINI_API_KEY
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASSWORD
- ALERT_EMAIL_FROM

2. Start backend

```bash
chmod +x run.sh
./run.sh
```

Backend endpoints:

- http://localhost:8000/health
- http://localhost:8000/history
- http://localhost:8000/analyze

3. Load extension in Chrome

- Open chrome://extensions/
- Enable Developer mode
- Click Load unpacked
- Select the extension/ folder

4. Configure extension popup

- Open popup -> Config tab
- Set client name
- Add keywords (one per line)
- Set alert email
- Verify backend URL is http://localhost:8000

5. Start monitoring

- Browse to https://www.facebook.com/groups/<group-id>
- Content script extracts visible posts
- Negative posts trigger:
  - popup alert entries
  - unread badge count
  - SMTP email alert

## Data Flow

1. content.js extracts posts from group feed DOM.
2. background.js sends posts to POST /analyze.
3. backend deduplicates with SQLite.
4. llm.py analyzes sentiment with Groq, then Gemini fallback.
5. backend saves results and sends email alerts for negative posts.
6. background.js stores alerts in chrome.storage.local and updates badge.
7. popup.js renders alerts, config, and stats.

## Known POC Limitations

- No WhatsApp alerts (email only)
- Facebook DOM changes can break selectors
- Backend is local-only and has no auth
- SQLite is used for POC simplicity
- Chrome-only in this version

## Future Graph API Upgrade Path

If Meta app permissions are approved later:

1. Request permissions for group access
2. Replace DOM scraping with API polling
3. Keep backend sentiment + alert pipeline unchanged

## Notes

- Email alerts are sent only for negative and very_negative sentiments.
- Email sending is rate-limited to once per 5 minutes per post_id.
- Background storage keeps up to 100 latest analyzed entries.
- Python 3.13 is supported by using a recent pydantic version with prebuilt wheels.

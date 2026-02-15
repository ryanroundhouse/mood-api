## Project snapshot
- **Project**: Moodful API (Node/Express) + static site + operational scripts
- **API runtime**: Node.js + Express (`server.js`, port **3000**)
- **Datastores**: SQLite (`database.sqlite`, `analytics.sqlite`)
- **Testing (Node)**: Node built-in **`node:test`** via `npm test`
- **Email UX**: Auth emails are HTML-first; password reset emails include a branded HTML template + plain-text fallback (`routes/auth.js`)
- **Security headers**: Baseline hardening headers (CSP/HSTS/etc.) applied via `helmet` (`middleware/securityHeaders.js`)
- **Last updated**: 2026-02-14

## How to run
- **Install**: `npm install`
- **Start server (dev)**: `npm run start` (runs `nodemon server.js`)
- **Start server (manual)**: `node server.js`
- **Run tests**: `npm test`

### Python scripts
- **Install deps**: `pip install -r scripts/requirements.txt`
- **Run example**: `python scripts/send_mood_request.py`
- **Run script tests**: `python -m unittest scripts.test_send_mood_request`

## Directory layout (high level)
- **Root**: server + DB owners + docs
  - `server.js` (Express server + route mounting + static site serving)
  - `database.js` (primary DB schema/migrations)
  - `analytics.js` (analytics DB schema + tracking)
- **`app/`**: static site served by Express
- **`app/toast.mjs`**: shared toast notifications for the static site (used instead of the old fixed header banner)
- **`routes/`**: API routers (auth, moods, user, stripe, google-play, apple-store, garmin, contact)
- **`middleware/`**: auth + rate limiting
- **`utils/`**: encryption, mailer, datetime, logger
- **`maintenance/`**: one-off scripts/migrations (Node)
- **`scripts/`**: operational Python jobs + utilities (+ a small unittest suite)
- **`tests/`**: Node unit tests (run by `npm test`)
- **`.cursor/rules/`**: agent rules for this repo

## Tooling & constraints
- Keep diffs small; no large refactors unless requested.
- Do not commit secrets or production data (`.env`, `*.sqlite`, key files are ignored).
- Preserve webhook parsing requirements (Stripe/Garmin raw-body routes configured in `server.js`).
- Prefer tests that don’t require real third-party credentials; mock/stub external APIs.
- Web auth uses an HttpOnly refresh cookie (Path `/`) via `/api/web-auth/*`; the static site should not persist auth tokens in `localStorage`.
- Authenticated HTML pages (`dashboard.html`, `weekly-summary.html`, `account-settings.html`) are server-gated using the refresh cookie (unauthenticated requests redirect to `login.html`).
- API rate limiting (production) applies to `/api/*` endpoints and keys by `cf-connecting-ip` (Cloudflare) with fallbacks to `x-forwarded-for` and `req.ip`.

## Auth endpoint prefixes (migration in progress)
- **`/api/web-auth/*`**: Web-only cookie-based auth (refresh token in HttpOnly cookie).
- **`/api/auth/*`**: Canonical non-cookie auth endpoints (mobile + web register/forgot/reset flows).
- **`/api/*`**: Legacy non-cookie auth endpoints (deprecated; still mounted for backwards compatibility during rollout).

## Current file tree (top-level)
```
.
├── .cursor/
│   └── rules/
├── AGENTS.md
├── CHANGELOG.md
├── DECISIONS.md
├── STATE.md
├── app/
├── maintenance/
├── middleware/
├── routes/
├── scripts/
├── tests/
├── utils/
├── analytics.js
├── database.js
├── package.json
└── server.js
```

## Handoff requirements
- Update this file when you change structure, commands, or testing conventions.
- Update `CHANGELOG.md` at the end of agent work (when repo changes were made).
- Ensure automated tests pass before considering a task complete:
  - `npm test` for Node/JS changes
  - relevant Python unit tests for script changes


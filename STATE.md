## Project snapshot
- Project: Moodful API
- Shape: one Node/Express server, one vanilla static site, one primary SQLite DB, one analytics SQLite DB, plus Python and Node operational scripts
- Real runtime entrypoint: `server.js`
- Port: `3000`
- Last updated: 2026-03-21

## How to run
- Install Node deps: `npm install`
- Start dev server: `npm run start`
- Start directly: `node server.js`
- Run Node tests: `npm test`
- Watch Node tests: `npm run test:watch`

### Python scripts
- Install script deps: `pip install -r scripts/requirements.txt`
- Example script: `python scripts/send_mood_request.py`
- Script tests: `python3 -m unittest scripts.test_send_mood_request scripts.test_send_mood_summary`

## High-level structure
- `server.js`: bootstraps env defaults, initializes both databases, configures middleware order, mounts routes, gates authenticated HTML, and serves `app/`
- `database.js`: owns `database.sqlite`, creates base tables, and performs additive migrations at startup
- `analytics.js`: owns `analytics.sqlite` and tracks mood submission analytics
- `routes/`: `auth.js`, `user.js`, `moods.js`, `breathing.js`, `stripe.js`, `contact.js`, `google-play.js`, `apple-store.js`, `garmin.js`
- `middleware/`: JWT auth, rate limiter, security headers, legacy auth deprecation, refresh-cookie HTML gating
- `utils/`: encryption, mailer, datetime helpers, logger
- `app/`: public pages plus authenticated pages like `dashboard.html`, `weekly-summary.html`, and `account-settings.html`
- `tests/`: Node tests for auth middleware, cookie auth flow, authenticated HTML routes, encryption, rate limiting, security headers, password reset email, datetime helpers, and toasts
- `scripts/`: operational Python scripts for email, Garmin, analytics, and utilities
- `maintenance/`: one-off Node migration and maintenance scripts

## Route mounts and behavior
- `auth` router is mounted at:
  - `/api`
  - `/api/auth`
  - `/api/web-auth`
- `moods` router is mounted at:
  - `/api/moods`
  - `/api/mood`
- Other mounted prefixes:
  - `/api/user`
  - `/api/breathing`
  - `/api/stripe`
  - `/api/contact`
  - `/api/google-play`
  - `/api/apple-store`
  - `/api/garmin`

## Current auth model
- `/api/web-auth/*` is the browser-oriented auth surface.
- `/api/auth/*` is the canonical JSON-token auth surface.
- `/api/*` still exposes legacy auth paths for backwards compatibility and adds deprecation signaling middleware.
- Web auth stores the refresh token in an `HttpOnly` cookie named `refreshToken` with `Path=/`.
- Authenticated HTML pages are checked server-side by `middleware/requireWebRefreshAuth.js` before `express.static()` runs.

## Datastores
- Primary DB: `database.sqlite`
  - Core tables include `users`, `moods`, `breathing_sessions`, `user_settings`, `custom_activities`, `summaries`, `refresh_tokens`, `mood_auth_codes`, `garmin_request_tokens`, `sleep_summaries`, and `daily_summaries`
  - Sensitive mood comments and summary payloads are encrypted before storage
- Analytics DB: `analytics.sqlite`
  - Tracks `mood_submissions`
  - Current sources supported in analytics are `dashboard`, `email`, `android`, and `ios`

## Important implementation constraints
- Keep middleware order intact around raw-body parsing:
  - `/api/stripe/webhook` uses `express.raw({ type: 'application/json' })`
  - `/api/garmin/sleep-webhook` uses `express.raw(...)` with a larger body limit
  - JSON and URL-encoded parsers are registered after those routes
- `trust proxy` is enabled, and production rate limiting keys by Cloudflare IP first, then forwarded IP, then `req.ip`
- Security headers come from `middleware/securityHeaders.js` via `helmet`
- The static site still uses inline scripts, inline styles, and some inline handlers, so the current CSP is intentionally permissive
- `package.json` lists `"main": "index.js"`, but the actual server entrypoint is `server.js`

## Current test inventory
- `tests/authMiddleware.test.js`
- `tests/authCookieFlow.test.js`
- `tests/authenticatedHtmlRoutes.test.js`
- `tests/breathingRoutes.test.js`
- `tests/datetime.test.js`
- `tests/encryption.test.js`
- `tests/passwordResetEmail.test.js`
- `tests/rateLimiter.test.js`
- `tests/securityHeaders.test.js`
- `tests/toast.test.js`
- `tests/userAccountDeletion.test.js`

## Operational scripts
- Python scripts include:
  - `send_mood_request.py`
  - `send-mood-summary.py`
  - `test_send_mood_summary.py`
  - `send-privacy-update-notification.py`
  - `calculate-usage-stats.py`
  - `convert_moods_to_local.py`
  - `fetch-garmin-sleep.py`
  - `generate-sample-sleep-data.py`
  - `pdf_to_markdown.py`
- Node maintenance scripts include:
  - `migrate-all-to-oauth2.js`
  - `migrate-summaries.js`
  - `encrypt-comments.js`
  - `add-mood-emojis.js`
  - `add-notification-time.js`
  - `add-google-play-subscription.js`
  - `duplicate-garmin-data.js`
  - `generate-sitemap.js`

## Handoff expectations
- Update this file whenever structure, commands, auth behavior, or testing conventions change.
- Update `CHANGELOG.md` whenever repo files changed during the task.
- Run relevant automated checks for code changes before considering the task complete.

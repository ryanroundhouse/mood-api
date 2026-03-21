## Purpose
This repo is the **Moodful API**: a Node/Express server that serves a JSON API and a vanilla static website from `app/`. It also includes operational Python scripts and one-off Node maintenance scripts. This file is the quick-start guide for future coding agents.

## Hard constraints
- Do not commit secrets, key files, `.env`, or SQLite database files.
- Keep diffs minimal. Avoid large refactors unless the user explicitly asks for one.
- Do not add new npm packages without permission.
- Keep the static site in `app/` vanilla HTML/CSS/JS only.
- Preserve security invariants:
  - Protected API routes must keep JWT auth enforced.
  - Encrypted fields must stay encrypted at rest via `utils/encryption.js`.
  - Stripe webhooks must keep raw-body parsing in `server.js`.
  - Garmin sleep webhook parsing must keep its dedicated raw-body handling in `server.js`.
- Do not add tests that require real Stripe, Mailgun, Google, Apple, or Garmin credentials. Mock or stub integrations instead.

## Repo map
- `server.js`: real runtime entrypoint, Express app setup, DB init, middleware order, route mounting, authenticated HTML gating, static file serving.
- `database.js`: primary SQLite schema and additive migrations for `database.sqlite`.
- `analytics.js`: analytics SQLite schema and mood submission tracking for `analytics.sqlite`.
- `routes/`: API routers for auth, users, moods, Stripe, contact, Google Play, Apple Store, and Garmin.
- `middleware/`: JWT auth, rate limiting, security headers, legacy auth deprecation, and authenticated HTML gating.
- `utils/`: encryption, mail transport, date helpers, and Winston logging.
- `app/`: public site and authenticated pages, all plain HTML/CSS/JS.
- `tests/`: Node unit tests using the built-in `node:test` runner.
- `scripts/`: Python operational jobs and small unittest coverage.
- `maintenance/`: one-off Node scripts and migrations.

## Current architecture notes
- The server listens on port `3000`.
- `server.js` mounts the same auth router at three prefixes:
  - `/api/*` for legacy auth compatibility
  - `/api/auth/*` for the canonical JSON-token auth surface
  - `/api/web-auth/*` for browser cookie-based auth
- Web auth stores the refresh token in an `HttpOnly` cookie named `refreshToken` with `Path=/` so it can support both refresh requests and server-gated HTML pages.
- Authenticated HTML pages are currently `dashboard.html`, `weekly-summary.html`, and `account-settings.html`; access is checked server-side before static file serving.
- Production-only general rate limiting is applied to `/api/*` and keys by `cf-connecting-ip`, then `x-forwarded-for`, then `req.ip`.
- Security headers are applied centrally by `middleware/securityHeaders.js`. The CSP is intentionally permissive because the static site still contains inline scripts, inline styles, and some inline event handlers.

## Required workflow
- Before making any edits:
  - Read `AGENTS.md`, `STATE.md`, and `DECISIONS.md`.
  - Read any directly relevant files you plan to touch.
- If you change code:
  - Add or update tests where practical.
  - Run the relevant checks:
    - Node/JS changes: `npm test`
    - Python script changes: run the relevant unittest modules, currently at minimum `python -m unittest scripts.test_send_mood_request`
- If you only change docs:
  - Tests are optional unless the docs describe behavior you also changed in code.
- End of session, if repo files changed:
  - Update `STATE.md` when structure, commands, or workflow notes changed.
  - Update `CHANGELOG.md` with the date, what changed, and why.
  - Update `DECISIONS.md` when documenting a non-trivial architectural or workflow decision.

## Commands
- Install Node deps: `npm install`
- Start dev server: `npm run start`
- Start without nodemon: `node server.js`
- Run Node tests: `npm test`
- Watch Node tests: `npm run test:watch`

### Python scripts
- Install deps: `pip install -r scripts/requirements.txt`
- Example run: `python scripts/send_mood_request.py`
- Script tests: `python -m unittest scripts.test_send_mood_request`

## Handoff requirements
- Leave `STATE.md` accurate for the next agent.
- Leave `CHANGELOG.md` updated when you changed repo files.
- Record non-trivial decisions in `DECISIONS.md`.
- In your final handoff, summarize what changed and what validation you did or did not run.


## Purpose
This repo is the **Moodful API**: a Node/Express server that serves a **JSON API** and a **static website** (`app/`). It also contains operational Python scripts and one-off maintenance jobs. These notes are for future coding agents working in this repo.

## Hard constraints (do not violate)
- **Do not commit secrets**: never commit `.env`, key files, credentials, or production data. Respect `.gitignore` (it excludes `.env`, `database.sqlite`, `analytics.sqlite`, and various key files).
- **Keep diffs minimal**. No large refactors unless explicitly requested.
- **Preserve security invariants**:
  - JWT auth must remain enforced for protected routes.
  - Encrypted fields must remain encrypted at rest (see `utils/encryption.js`).
  - Stripe webhook routes must keep **raw-body** parsing requirements (see `server.js`).
- **Do not introduce tests that require real third-party credentials** (Stripe/Mailgun/Google/Apple/Garmin). Use mocks/stubs and/or dependency injection.

## Repo conventions
- **Runtime entrypoint**: `server.js` (Express + static file serving + route mounting).
- **Routes**: `routes/` (Express routers mounted in `server.js`).
- **Middleware**: `middleware/` (auth, rate limiting, etc.).
- **Shared utilities**: `utils/` (encryption, mailer, datetime, logger).
- **Databases**:
  - Primary DB: `database.sqlite` (owned by `database.js`)
  - Analytics DB: `analytics.sqlite` (owned by `analytics.js`)
- **Static site**: `app/` (served by Express via `express.static()`).
- **Operational scripts**: `scripts/` (Python jobs; see `scripts/requirements.txt`).
- **One-off maintenance**: `maintenance/` (Node scripts/migrations).

## Required workflow (agent)
- Before making ANY edits:
  - Read **`AGENTS.md`**, **`STATE.md`**, and **`DECISIONS.md`**.
- If you change code:
  - Add/update unit tests for the change.
  - Run the relevant tests and ensure they pass:
    - **Node/JS changes**: `npm test`
    - **Python script changes**: run the script’s unit tests (currently `scripts/test_send_mood_request.py` via `python -m unittest`)
- End of session (only if you made repo changes):
  - Update **`STATE.md`** (structure + how to run + testing).
  - Update **`CHANGELOG.md`** (date + what changed + why).
  - If you made a non-trivial decision (tooling/structure/constraints), add an ADR entry to **`DECISIONS.md`**.

## Commands
- **Install**: `npm install`
- **Run dev server**: `npm run start` (uses `nodemon server.js`)
- **Run tests (required for code changes)**: `npm test`

### Python scripts
- **Deps**: `pip install -r scripts/requirements.txt`
- **Example script run**: `python scripts/send_mood_request.py`

## Handoff requirements
- **STATE.md updated** with current structure + how to run + how to test.
- **CHANGELOG.md updated** with what changed and why.
- **Tests passing**:
  - `npm test` for Node/JS changes
  - relevant Python unit tests for script changes
- Any new decisions captured in **DECISIONS.md** (mini-ADR entry).


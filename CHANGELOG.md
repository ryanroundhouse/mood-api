## Agent change log

### Unreleased
- **2026-03-21**: Seeded representative `breathing_sessions` rows for `userId = 5` in `database.sqlite` and updated `app/dashboard.html` so the calendar shows breathing-session context alongside mood, sleep, steps, and distance using the authenticated `/api/breathing/sessions` API.
- **2026-03-21**: Implemented breathing session backend support end to end: added the authenticated `/api/breathing` API, the `breathing_sessions` SQLite table plus indexes, account-deletion cleanup, breathing-aware LLM summary input in `scripts/send-mood-summary.py`, and Node/Python test coverage. Also updated `breathing_tracking_requirements.md` to document the shipped frontend contract.
- **2026-03-21**: Extended `breathing_tracking_requirements.md` with repo-specific implementation guidance for the new breathing feature, covering the additive SQLite schema, authenticated REST endpoints, account-deletion impact, and how `scripts/send-mood-summary.py` should include breathing session data in LLM mood summaries.
- **2026-03-21**: Refreshed `AGENTS.md`, `STATE.md`, and `DECISIONS.md` so agent docs match the current repository layout, route mounts, test inventory, and the root-scoped web auth refresh cookie used for authenticated HTML gating.
- **2026-02-14**: Added agent workflow docs (`AGENTS.md`, `STATE.md`, `DECISIONS.md`) and changelog template so future tasks start with clear constraints and end with consistent handoffs.
- **2026-02-14**: Hardened web auth token storage by moving refresh tokens to an `HttpOnly` cookie for `/api/web-auth/*`, removing `localStorage` token persistence from `app/`, and adding tests + docs while preserving legacy JSON refresh-token flows under `/api/*` (and keeping `/api/auth/*` mounted for mobile backwards compatibility).
- **2026-02-14**: Began migrating canonical non-cookie auth to `/api/auth/*`: updated web register/forgot/reset pages and the mobile app to call `/api/auth/*`, added deprecation headers/logging for legacy `/api/*` auth calls, and redirected `/api/verify/:token` to `/api/auth/verify/:token` to preserve old verification links.
- **2026-02-14**: Improved the password reset email UX with a branded HTML template (logo + headline + button CTA), added an expiry + security note, and included a plain-text fallback part (with a unit test).
- **2026-02-14**: Enforced server-side auth for authenticated HTML pages (`dashboard.html`, `weekly-summary.html`, `account-settings.html`) by validating the web refresh cookie against `refresh_tokens` and redirecting unauthenticated requests to `login.html` (defense-in-depth, Issue #10).
- **2026-02-14**: Added baseline security headers (CSP, HSTS on HTTPS in prod, XFO, nosniff, referrer-policy, permissions-policy) at the Express layer to reduce XSS/clickjacking risk (Issue #5).
- **2026-02-14**: Replaced the fixed success/error banner in `app/` with toast notifications (`app/toast.mjs` + CSS) so messages don’t cover header navigation (and added a small unit test).
- **2026-02-14**: Adjusted API rate limiting to key by `cf-connecting-ip` (Cloudflare) with safe fallbacks and increased the general limit to **500 requests per 15 minutes** to reduce false-positive 429s behind the CDN.

## Handoff requirements
- Add a bullet for each agent session with **date + what changed + why** (when repo changes were made).
- Update `STATE.md` when structure/commands/testing conventions change.

## Agent change log

### Unreleased
- **2026-02-14**: Added agent workflow docs (`AGENTS.md`, `STATE.md`, `DECISIONS.md`) and changelog template so future tasks start with clear constraints and end with consistent handoffs.
- **2026-02-14**: Hardened web auth token storage by moving refresh tokens to an `HttpOnly` cookie for `/api/web-auth/*`, removing `localStorage` token persistence from `app/`, and adding tests + docs while preserving legacy JSON refresh-token flows under `/api/*` (and keeping `/api/auth/*` mounted for mobile backwards compatibility).
- **2026-02-14**: Began migrating canonical non-cookie auth to `/api/auth/*`: updated web register/forgot/reset pages and the mobile app to call `/api/auth/*`, added deprecation headers/logging for legacy `/api/*` auth calls, and redirected `/api/verify/:token` to `/api/auth/verify/:token` to preserve old verification links.
- **2026-02-14**: Improved the password reset email UX with a branded HTML template (logo + headline + button CTA), added an expiry + security note, and included a plain-text fallback part (with a unit test).
- **2026-02-14**: Enforced server-side auth for authenticated HTML pages (`dashboard.html`, `weekly-summary.html`, `account-settings.html`) by validating the web refresh cookie against `refresh_tokens` and redirecting unauthenticated requests to `login.html` (defense-in-depth, Issue #10).
- **2026-02-14**: Added baseline security headers (CSP, HSTS on HTTPS in prod, XFO, nosniff, referrer-policy, permissions-policy) at the Express layer to reduce XSS/clickjacking risk (Issue #5).

## Handoff requirements
- Add a bullet for each agent session with **date + what changed + why** (when repo changes were made).
- Update `STATE.md` when structure/commands/testing conventions change.


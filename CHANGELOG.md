## Agent change log

### Unreleased
- **2026-02-14**: Added agent workflow docs (`AGENTS.md`, `STATE.md`, `DECISIONS.md`) and changelog template so future tasks start with clear constraints and end with consistent handoffs.
- **2026-02-14**: Hardened web auth token storage by moving refresh tokens to an `HttpOnly` cookie for `/api/web-auth/*`, removing `localStorage` token persistence from `app/`, and adding tests + docs while preserving legacy JSON refresh-token flows under `/api/*` (and keeping `/api/auth/*` mounted for mobile backwards compatibility).
- **2026-02-14**: Began migrating canonical non-cookie auth to `/api/auth/*`: updated web register/forgot/reset pages and the mobile app to call `/api/auth/*`, added deprecation headers/logging for legacy `/api/*` auth calls, and redirected `/api/verify/:token` to `/api/auth/verify/:token` to preserve old verification links.

## Handoff requirements
- Add a bullet for each agent session with **date + what changed + why** (when repo changes were made).
- Update `STATE.md` when structure/commands/testing conventions change.


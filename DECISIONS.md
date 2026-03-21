## Decision log (mini-ADR)

### ADR-0001 — Agent-facing handoff docs are required
- Status: Accepted
- Date: 2026-02-14
- Context: Agents need a fast way to learn repo constraints and leave useful handoffs for the next task.
- Decision:
  - Keep `AGENTS.md`, `STATE.md`, `DECISIONS.md`, and `CHANGELOG.md` in the repo.
  - Require agents to read the first three before editing.
- Consequences:
  - Repo conventions stay discoverable.
  - Task handoffs stay auditable and easier to continue.

### ADR-0002 — Use the built-in Node test runner
- Status: Accepted
- Date: 2026-02-14
- Context: The project needs automated tests without adding extra test framework overhead.
- Decision:
  - Use `node:test` with CommonJS.
  - Run tests with `npm test` and `npm run test:watch`.
- Consequences:
  - Test setup stays lightweight.
  - New tests should avoid real third-party credentials and prefer mocks or stubs.

### ADR-0003 — Keep three auth surfaces during migration
- Status: Accepted
- Date: 2026-02-14
- Context: Browser clients and non-browser clients have different security and compatibility needs.
- Decision:
  - Keep `/api/web-auth/*` for browser auth with an `HttpOnly` refresh cookie.
  - Keep `/api/auth/*` as the canonical JSON-token auth surface.
  - Keep legacy `/api/*` auth routes mounted for backwards compatibility while signaling deprecation.
- Consequences:
  - Web clients can avoid exposing refresh tokens to JavaScript.
  - Existing clients can keep working during auth-surface migration.

### ADR-0004 — Apply baseline security headers in Express
- Status: Accepted
- Date: 2026-02-14
- Context: Security headers should be enforced by the application, not only by edge infrastructure.
- Decision:
  - Apply headers centrally with `helmet` via `middleware/securityHeaders.js`.
  - Keep the CSP intentionally permissive for now because the static site still uses inline scripts, inline styles, and some inline handlers.
  - Only emit HSTS for secure production requests.
- Consequences:
  - Public and authenticated pages get consistent hardening headers.
  - Tightening CSP later will require static-site cleanup first.

### ADR-0005 — Scope the web refresh cookie to `/`
- Status: Accepted
- Date: 2026-03-21
- Context: The browser auth flow now protects full HTML pages in addition to XHR refresh requests. A cookie scoped only to `/api/web-auth` cannot support server-side gating for `dashboard.html`, `weekly-summary.html`, and `account-settings.html`.
- Decision:
  - Store the web refresh token in an `HttpOnly` cookie named `refreshToken` with `Path=/`.
  - Validate that cookie in `middleware/requireWebRefreshAuth.js` before serving authenticated HTML pages.
- Consequences:
  - The server can gate authenticated HTML as defense-in-depth before `express.static()` runs.
  - Cookie clearing must continue to match the same cookie attributes in `routes/auth.js`.

## Handoff requirements
- Add a new ADR when a change introduces or formalizes a non-trivial architectural or workflow decision.
- Keep entries short and grounded in current code.


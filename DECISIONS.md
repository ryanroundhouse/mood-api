## Decision log (mini-ADR)

### ADR-0001 — Agent workflow docs + Cursor rules
- **Status**: Accepted
- **Date**: 2026-02-14
- **Context**: We want agents to be productive immediately on task start (what to read, repo constraints) and to leave consistent, durable handoffs at task end.
- **Decision**:
  - Add agent-facing docs: `AGENTS.md`, `STATE.md`, `CHANGELOG.md`, `DECISIONS.md`.
  - Add modern Cursor rules under `.cursor/rules/` to enforce “read-before-edit” and “record-at-end”.
- **Consequences**:
  - Agents have a single, consistent place to learn constraints and conventions.
  - Repo handoffs become auditable (state + changelog + ADRs when needed).

### ADR-0002 — Minimal Node test harness (node:test, CommonJS)
- **Status**: Accepted
- **Date**: 2026-02-14
- **Context**: This repo needs mandatory automated testing for code changes without adding heavy tooling.
- **Decision**:
  - Use Node’s built-in test runner: `node:test` + `node:assert/strict`.
  - Run tests via `npm test` (`node --test`).
  - Keep the codebase in CommonJS (no `"type": "module"` migration).
- **Consequences**:
  - Tests can run with minimal dependencies and fast startup.
  - New tests should prefer pure modules and avoid requiring real third-party credentials.

### ADR-0003 — Dual-mode auth refresh tokens (web HttpOnly cookie + legacy JSON)
- **Status**: Accepted
- **Date**: 2026-02-14
- **Context**: Storing JWT access/refresh tokens in browser `localStorage` increases account-takeover impact if any XSS exists. We also have non-browser clients that expect the existing JSON refresh-token flow.
- **Decision**:
  - For the static web app, use `/api/web-auth/*` endpoints that store the refresh token in an `HttpOnly` cookie (scoped to `Path=/api/web-auth`) and never return the refresh token to JS.
  - Preserve the existing JSON refresh-token flow under `/api/*` (and keep `/api/auth/*` mounted for backwards compatibility with the mobile client) where login returns `{accessToken, refreshToken}` and refresh/logout accept `refreshToken` in the JSON body.
- **Consequences**:
  - Web clients no longer persist auth tokens in `localStorage`, reducing XSS exfiltration risk.
  - External clients retain backwards compatibility via the legacy `/api/*` contract.

### ADR-0004 — Express-layer baseline security headers (helmet)
- **Status**: Accepted
- **Date**: 2026-02-14
- **Context**: Pentest finding: key security headers were missing on both public and authenticated pages (e.g., `/`, `/dashboard.html`). We want consistent app-layer headers without depending on edge (Cloudflare).
- **Decision**:
  - Apply baseline security headers globally in Express via `helmet` + a small wrapper middleware (`middleware/securityHeaders.js`).
  - Use a baseline CSP that **allows inline scripts/styles** initially because the static site under `app/` contains substantial inline `<script>` / `<style>`; tighten later via refactor/nonces/hashes.
  - Emit HSTS only in production mode and only when the request is effectively HTTPS (respects `X-Forwarded-Proto` with `trust proxy`).
- **Consequences**:
  - All HTML and API responses get consistent hardening headers.
  - CSP is an incremental improvement rather than a strict lock-down until the static site is refactored.

## Handoff requirements
- Add a new ADR when making a non-trivial change in approach (tooling, structure, constraints).
- Keep entries short; link to files/paths when relevant.


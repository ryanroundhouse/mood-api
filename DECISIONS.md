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

## Handoff requirements
- Add a new ADR when making a non-trivial change in approach (tooling, structure, constraints).
- Keep entries short; link to files/paths when relevant.


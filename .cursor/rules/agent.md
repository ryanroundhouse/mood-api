## Mood API agent workflow (must follow)

This repo is a Node/Express API + static site + SQLite + operational scripts repo.

Before making ANY edits:
- Read `AGENTS.md`, `STATE.md`, and `DECISIONS.md`.

Hard constraints:
- Do not commit secrets or production data (respect `.gitignore`: `.env`, `database.sqlite`, `analytics.sqlite`, key files).
- Keep diffs minimal. No large refactors unless explicitly requested.
- Preserve security invariants:
  - JWT auth remains enforced for protected routes.
  - Encrypted fields remain encrypted at rest (see `utils/encryption.js`).
  - Webhook parsing requirements remain correct (Stripe + Garmin raw-body routes in `server.js`).
- Prefer tests that don’t require real third-party credentials (Stripe/Mailgun/Google/Apple/Garmin). Use mocks/stubs and/or dependency injection.

Testing requirements (task is not complete until green):
- If you change **Node/JS code**, you MUST add/update unit tests under `tests/` and ensure `npm test` passes.
- If you change **Python scripts**, you MUST add/update unit tests and run them (currently `python -m unittest scripts.test_send_mood_request`).
- If you only change docs/markdown, tests are optional (but keep them green if you ran them).

End-of-session requirements (only if you made repo changes):
- Update `STATE.md` (how to run + how to test + structure when relevant).
- Update `CHANGELOG.md` (date + what changed + why).
- If you made a non-trivial decision (tooling/structure/constraints), add an ADR entry to `DECISIONS.md`.


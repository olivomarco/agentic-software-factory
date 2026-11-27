# Contributor instructions

Demo todo app used to exercise the SDLC factory workflow. Zero dependencies; Node 22+.

- `backend/` - plain Node HTTP server and REST API (`/api/todos`). In-memory storage.
- `frontend/` - static HTML/CSS/JS served by the backend. Pure logic lives in `frontend/logic.js` so it can be unit tested.

## Commands

- `npm start` - run on http://localhost:3000 (`PORT` overrides)
- `npm test` - run all backend and frontend tests (`node --test`)

## Conventions

- Add or update tests alongside every behavior change (`*.test.js` next to the code).
- Keep the project dependency-free unless a ticket requires otherwise.
- Do not modify `.github/` in a feature or review change; workflow, agent and instruction changes need a separate human-reviewed PR (enforced by `CODEOWNERS`).

## Agent skills

Skills in `.github/skills/` come from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT).

### Issue tracker

GitHub issues, with native sub-issues and blocked-by dependencies. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus the factory's own labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created when the first term or decision is settled. See `docs/agents/domain.md`.

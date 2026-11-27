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
- Do not modify `.github/`, `.devcontainer/` or `scripts/` in a feature or review change; workflow, agent, environment and instruction changes need a separate human-reviewed PR (enforced by `CODEOWNERS`).
- Environment setup lives in `scripts/bootstrap.sh`, shared by the dev container (Codespaces), the cloud agent and CI.

## Agent skills

Skills in `.github/skills/` come from [mattpocock/skills](https://github.com/mattpocock/skills)
and [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT).

Before implementing code or addressing review feedback, load
`.github/skills/ponytail/SKILL.md` in default `full` mode without a manual
command or mode announcement. Use the smallest complete solution; repository
testing, security, accessibility and PR evidence requirements still apply.

### Issue tracker

GitHub issues, with native sub-issues and blocked-by dependencies. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus the factory's own labels. See `docs/agents/triage-labels.md`.

### Implementing and reviewing

The cloud agent builds one ticket with `implement` and `tdd` and writes the PR
with `pr` (Summary, Evidence, Merge Danger with `**Door:** one-way|two-way`).
`code-review` (adapted for Copilot code review) reviews every PR on two axes,
`[Standards]` and `[Spec]`. `implement-spec` builds a whole approved spec from
one local session. See `.github/skills/README.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created when the first term or decision is settled. See `docs/agents/domain.md`.

# Copilot instructions

Read `AGENTS.md` (commands and conventions) and `CODING_STANDARDS.md` before
changing or reviewing code. When reviewing, cite violated rules by their
`CODING_STANDARDS.md` heading and check that the change does what the linked
ticket asks.

- Add or update a `*.test.js` next to every behavior change; `npm test` must pass.
- The project is dependency-free; do not add packages.
- Never modify `.github/` as part of a feature or review change.

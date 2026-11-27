# Factory cockpit (Copilot CLI canvas)

A side panel in Copilot CLI over the factory: the triage queue by stage, specs
with their ticket trees and blockers, and open pull requests grouped by what the
risk gate decided. It reads and acts through your signed-in `gh`, so every
change is made as you, with your permissions.

## Open it

Start `copilot` in this repository (project extensions load from
`.github/extensions/`), then ask: "open the factory cockpit". To point it at
another repository: "open the factory cockpit for OWNER/REPO".

## Buttons

| Button | What happens |
|---|---|
| Grill here | Sends a prompt to this CLI session: the agent reads the issue, interviews you with the `grill-with-docs` skill (one question at a time) and posts a `## Grilling summary (local session)` comment on the issue |
| /grill, /spec | Comments the slash command; the gh-aw workflow answers on the issue |
| Ready for agent | Adds `ready-for-agent` (gate) |
| Approve spec | Adds `spec:approved` after a confirmation (gate) |
| Approve head | Adds `human-approved` to a high-risk PR (gate, cleared on the next push) |
| Hold / Release hold | Adds or removes `hold` |
| Re-run gate, Dispatch | Runs `risk-gate.yml` for the PR, or `dispatch.yml` |

The agent can drive the canvas too (`get_state`, `show`, and `run` for
`grill`, `spec`, `retriage`, `gate-pr`, `dispatch`), but the gate buttons are
deliberately not exposed to it: approving a spec, starting the agent and
approving a risky PR stay a human click.

The panel is served from a loopback port behind a random path, refreshes every
minute and after each action.

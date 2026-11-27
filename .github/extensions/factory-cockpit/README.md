# Factory cockpit (Copilot CLI canvas)

A side panel in Copilot CLI over the factory: the triage queue by stage, specs
with their ticket trees and blockers, and open pull requests grouped by what the
risk gate decided. Recently closed work is one click away. It reads and acts through your signed-in `gh`, so every
change is made as you, with your permissions.

## Open it

Start `copilot` in this repository (project extensions load from
`.github/extensions/`), then ask: "open the factory cockpit". In a Codespace
the Copilot CLI is preinstalled by `scripts/bootstrap.sh`; run `/login` once,
and `gh auth login` if the Project column stays empty (the codespace token is
scoped to the repository). The canvas port is forwarded like any other. To point it at
another repository: "open the factory cockpit for OWNER/REPO".

## Buttons

| Button | What happens |
|---|---|
| Grill here | Sends a prompt to this CLI session: the agent reads the issue, interviews you with the `grill-with-docs` skill (one question at a time) and posts a `## Grilling summary (local session)` comment on the issue. When a state-model or UI question cannot be settled in words, it offers a throwaway prototype (`prototype` skill): the verdict goes in the summary, the prototype on a `prototype/issue-N-*` branch if you agree |
| Architecture review (toolbar), Review here (on an `[architecture]` issue) | Sends a prompt to this CLI session: the `improve-codebase-architecture` skill writes an HTML report of deepening candidates (from a fresh scan, or checking the scout's), grills you through the one you pick and files the agreed refactor as a `refactor` issue, ready for `/spec`. Glossary and ADR edits stay uncommitted until you say so |
| /spec | Comments the slash command; the gh-aw workflow writes the spec on the issue |
| Build here | On an approved spec: adds `lane:local` (the dispatcher stops assigning its tickets) and sends a prompt that builds the whole spec in this session with the `implement-spec` skill on `local/spec-N`, then opens one pull request into the default branch (always high risk). Asks before every push |
| Ready for agent | Adds `ready-for-agent` (gate) |
| Approve spec | Adds `spec:approved` after a confirmation (gate) |
| Approve head | Adds `human-approved` to a high-risk PR (gate, cleared on the next push) |
| Hold / Release hold | Adds or removes `hold` |
| Re-run gate, Dispatch | Runs `risk-gate.yml` for the PR, or `dispatch.yml` |
| Retry agent | On an `agent:failed` ticket: re-adds `ready-for-agent` for a new session and a fresh retry budget (gate) |
| Re-triage, Close report | On `factory:failure` issues: re-run triage, or close a gh-aw `[aw]` failure report |
| Re-run failed jobs | Re-runs a workflow whose latest run in the last 24 hours failed |

**Needs attention** opens the Queue tab, and its count turns the tab badge red:
tickets the agent gave up on, failed triage, gh-aw failure reports and failed
runs. See "When things fail" in `docs/factory.md`.

## Find things

- **Open / Closed / All**, next to the search box, switches every tab between
  open work and the 50 most recently closed issues, specs and pull requests
  (done or not planned; merged or closed unmerged). The choice is remembered.
- **Quick filters**, the chips under the search box, are per tab (Needs a human,
  Agent, Blocked, Bugs… on the Queue; Low or High risk, Into `main`, Merged… on
  PRs). Each one shows how many items it would leave and toggles a qualifier
  in the search box, so you can see and edit what is applied.
- **The search box** takes free text (number, title, label) and GitHub-style
  qualifiers, which it suggests as you type (`Tab` or `Enter` to accept):

  | Qualifier | Matches |
  |---|---|
  | `is:open`, `is:closed`, `is:merged`, `is:unmerged` | State |
  | `is:done`, `is:wontfix` | Closed as completed (or merged), or as not planned |
  | `is:human`, `is:agent`, `is:blocked`, `is:failed` | Waiting for a person, on the cloud agent, blocked, given up on |
  | `is:spec`, `is:draft` | Specs, draft pull requests |
  | `label:NAME`, `risk:low\|high`, `base:BRANCH`, `author:LOGIN`, `assignee:LOGIN` | As on GitHub; `base:` matches a prefix, so `base:factory/` is every spec branch |

  Prefix any term with `-` to exclude it (`-label:bug`). Each tab keeps its own
  filter.

The agent can drive the canvas too (`get_state`, `show` with a tab, `state` and
`filter`, and `run` for
`spec`, `retriage`, `retriage-failed`, `gate-pr`, `dispatch`, `rerun-run`), but the gate buttons are
deliberately not exposed to it: approving a spec, starting the agent and
approving a risky PR stay a human click.

Keyboard: `/` filters, `r` refreshes, `1` `2` `3` switch tabs, `o` `c` `a` show open, closed or all, `Esc` clears. Rarely used actions
(Re-triage, Won't fix, Re-run gate) sit in each card's `⋯` menu; gate actions and Won't fix ask
for confirmation in the panel.

The panel is served from a loopback port behind a random path, refreshes every
minute and after each action.

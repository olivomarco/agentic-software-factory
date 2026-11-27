# Triage labels

The skills speak in terms of five canonical triage roles. This repo uses the
same strings.

| Role in mattpocock/skills | Label in this repo | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | A maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified; the factory assigns the Copilot cloud agent |
| `ready-for-human` | `ready-for-human` | Needs a human implementer |
| `wontfix` | `wontfix` | Will not be actioned |

Category labels: `bug`, `enhancement`.

Factory labels (set by workflows or maintainers, never by the triage skill):

| Label | Set by | Meaning |
| --- | --- | --- |
| `spec` | `/spec` | The issue body holds a spec waiting for approval |
| `spec:approved` | a maintainer | Human gate: break the spec into tickets and build it |
| `status:in-progress` | dispatch | The cloud agent is working on this ticket |
| `possible-duplicate` | triage | Triage found a likely duplicate |
| `risk:low` / `risk:high` | risk gate | Result of the merge risk policy on a PR |
| `hold` | a maintainer | Force human review on a PR, whatever its risk |
| `human-approved` | a maintainer | Human sign-off on a high-risk PR (counts as approval) |
| `needs-human` | dispatch | The review fix loop gave up on a PR; a human resolves and approves |
| `lane:local` | the cockpit's Build here | The spec is built locally with `implement-spec`; dispatch skips its tickets |

Only a maintainer adds `ready-for-agent` to a standalone issue; the plan
workflow adds it to tickets cut from an approved spec.

# Skills

Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at
commit `6f7f7831a625f040a8e06a0e7954826b87ce775a`, MIT licence (see
`LICENSE-mattpocock-skills`). Copied unchanged, minus the `agents/` metadata,
except `code-review`, adapted so Copilot code review can run it on pull
requests (see the note at the top of its `SKILL.md`).

| Skill | Used by |
| --- | --- |
| `grilling`, `grill-with-docs`, `domain-modeling` | the cockpit canvas session (Grill here) |
| `to-spec` | the cockpit canvas session and `/spec` |
| `to-tickets` | the `plan` workflow after `spec:approved` |
| `triage` | the cockpit canvas session and the `triage` workflow |
| `implement`, `tdd`, `pr` | the `factory-implementer` custom agent, one ticket per cloud agent session |
| `diagnosing-bugs` | the `factory-implementer` agent on bug tickets (feedback loop before the fix); `triage` names the loop in bug briefs |
| `code-review` | Copilot code review on every pull request; `implement` for its self-review |
| `improve-codebase-architecture` | the weekly `architecture-scout` workflow (report only) and the cockpit's Architecture review (report and grilling) |
| `codebase-design` | `tdd` and `improve-codebase-architecture`: deep modules, seams, the deletion test |
| `implement-spec` | the local fast lane: one Copilot CLI session (Codespace or laptop) builds a whole approved spec |

`implement`, `implement-spec`, `pr` and `improve-codebase-architecture` only
run when named explicitly; the custom agent, the workflows and the cockpit
name them.

The repo-specific configuration these skills read lives in `docs/agents/`.
To update, re-copy from upstream and keep the commit hash above current.

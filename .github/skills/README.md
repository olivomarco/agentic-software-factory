# Skills

Except `ponytail`, vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at
commit `6f7f7831a625f040a8e06a0e7954826b87ce775a`, MIT licence (see
`LICENSE-mattpocock-skills`). Copied unchanged, minus the `agents/` metadata,
except `code-review`, adapted so Copilot code review can run it on pull
requests (see the note at the top of its `SKILL.md`).

`ponytail` is copied unchanged from
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at commit
`ebd8654c2c627f721eb8f9c0d1bd4090a29f9e10`, MIT licence (see
`LICENSE-ponytail`). Coding agents load it automatically in `full` mode via
`AGENTS.md` and the `factory-implementer` instructions. It guides simplicity,
not exceptions to the factory's testing, review or PR evidence requirements.

| Skill | Used by |
| --- | --- |
| `ponytail` | coding agents, including `factory-implementer`, before implementation and review fixes; no manual activation |
| `grilling`, `grill-with-docs`, `domain-modeling` | the cockpit canvas session (Grill here) |
| `prototype` | offered by the cockpit's grilling and architecture review prompts when a state-model or UI question needs a throwaway prototype; the verdict feeds `to-spec` |
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
To update, re-copy from the corresponding upstream and keep its commit hash above current.

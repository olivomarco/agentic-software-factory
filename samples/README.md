# Sample issues

Taken from the earlier factory demo, plus two large requests for the spec
path. Create them with `samples/create-issues.sh` (`--dry-run` lists them
first) after `scripts/setup-repo.sh`. Triage runs on every new issue by itself;
add the `triage` label to run it again.

| Issue | What to do | What it exercises |
|---|---|---|
| Add a dark mode toggle | `ready-for-agent` | Happy path: low risk, merges itself after CI + Copilot review |
| Add a todo filter: all, active, completed | `ready-for-agent` | Frontend feature with pure logic and unit tests |
| Add a due date to todos | `ready-for-agent` | Backend + frontend: may exceed the size limit, expect `risk:high` |
| Rename the demo page heading to "My todos" | `ready-for-agent` | Smallest change, fastest end-to-end auto-merge |
| Make the app better | nothing | Triage should answer `needs-info` and write no brief |
| Support a dark theme | nothing | Duplicate of the dark mode toggle: expect `possible-duplicate` |
| Todos can be created with only spaces as the title | nothing | Bug: triage reproduces and writes a brief |
| Persist todos between server restarts | `/grill`, then `/spec` | Design decision under the dependency-free constraint |
| Add drag and drop reordering of todos | `/grill` | Larger change that overlaps with persistence |
| Show a count of remaining todos in the page title | `ready-for-agent` | Small change |
| Add keyboard shortcut to focus the new todo input | `/grill` | Vague edge cases (typing in other fields) |
| Keep long todo titles readable on narrow screens | nothing | Shares a cause with the long URL issue |
| Check whether a long URL pushes todo controls off-screen | nothing | Expect a related-or-duplicate call |
| Keep keyboard focus predictable when deleting a todo | nothing | Investigation only |
| Make accidental todo deletion recoverable | nothing | "Do not implement" must be respected |
| Give the empty todo list a clear first action | nothing | Investigation of an empty state |
| Organise todos into lists | `/grill` x N, `/spec`, `spec:approved` | Full spec path: sub-issues, blocked-by, `factory/spec-N`, integration PR |
| Undo for everything | `/grill`, `/spec`, `spec:approved` | Spec path with a cross-cutting design (ADR candidate) |

Suggested first run: "Rename the demo page heading" end to end (watch it merge
itself), then "Organise todos into lists" through the whole spec path.

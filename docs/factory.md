# Software factory (advanced)

Issues become specs, specs become tickets, tickets become small pull requests
that the Copilot cloud agent writes and the factory merges on its own when
they are low risk. Humans decide **what** gets built (spec approval) and look
at **risky** changes; they no longer review every diff.

Everything runs on GitHub primitives: gh-aw agentic workflows, native
sub-issues and blocked-by dependencies, the Copilot cloud agent, Copilot code
review (with a repository skill), rulesets, environments, Codespaces and a
Project board. Two deterministic
workflows (`dispatch.yml`, `risk-gate.yml`) do the bookkeeping without a model.

```text
issue opened
  v
triage.md ........ category + state labels, agent brief or questions (triage skill)
  |
  |-- small and clear -> maintainer adds ready-for-agent ----------------------.
  |                                                                            |
  |-- big or vague:                                                            |
  |   grill ........ cockpit "Grill here": live interview (grill-with-docs)    |
  |   /spec ........ ## Spec appended to the issue, label spec (to-spec skill) |
  |   HUMAN GATE: maintainer adds spec:approved                                |
  |   plan.md ...... sub-issues with blocked-by edges, ready-for-agent         |
  |                  (to-tickets skill)                                        |
  v                                                                            v
dispatch.yml ..... assigns unblocked tickets to the cloud agent (max 3 at a time)
                   base = factory/spec-N for spec tickets, else the default branch
  v
cloud agent ...... draft PR: factory-implementer agent, implement + tdd skills,
                   PR body by the pr skill (diagram, before/after evidence,
                   Merge Danger door + blast radius), "Fixes #n"
  v
risk-gate.yml .... marks it ready, asks for a Copilot review, labels risk:low / risk:high,
                   publishes the factory/risk-gate status
  |
Copilot code review  [Standards] / [Spec] comments (code-review skill: ticket + parent spec)
  |-- comments -> dispatch.yml asks @copilot to fix them (max 2 rounds, then needs-human)
  |-- risk:low  + CI green + Copilot reviewed + no blocking threads -> squash merge
  |-- risk:high -> gate comment with "Open in Codespace" (app running on the PR branch)
  |               HUMAN: approve (or add human-approved) -> merge
  v
dispatch.yml ..... closes the ticket, assigns the tickets it unblocked; when every
                   ticket of a spec is done, opens factory/spec-N -> main
  v
integration PR ... always waits for a human (one review per feature, not per ticket)
```

## Human gates

| Gate | Who | How |
|---|---|---|
| Start work on a small ticket | write access | add `ready-for-agent` (the dispatcher ignores it from anyone else) |
| Approve a spec | admin / maintain | add `spec:approved` to the issue carrying `## Spec` |
| Risky pull request | write access | approve the current head, or add `human-approved` (it approves only the head it was added on) |
| Feature integration | write access | approve the `factory/spec-N` pull request |
| Never merge automatically | anyone with triage | add `hold` |
| Review fix loop gave up | write access | resolve the threads on the `needs-human` PR, then approve |
| Build a spec yourself | write access | **Build here** in the cockpit (labels the spec `lane:local`) |

Runs never wait for a human: every stage reacts to an event (comment, label,
review) and exits, so the factory survives a weekend of nobody looking.

## Risk policy (`.github/factory/policy.cjs`)

A pull request is **low risk** when all of these hold:

- at most 300 changed lines and 12 files;
- it touches none of `.github/`, `.devcontainer/`, `scripts/`,
  `package.json` / `package-lock.json`, `AGENTS.md`, `CODING_STANDARDS.md`,
  `docs/adr/` (renames count on both sides);
- it carries no `hold` or `needs-human` label;
- its description does not declare a one-way door (`**Door:** one-way` in the
  pr skill's Merge Danger section). The door can only raise the risk: a
  two-way door never makes a large or sensitive change low risk;
- its branch lives in this repository (not a fork);
- it is not a spec integration pull request (`FACTORY_AUTO_MERGE_INTEGRATION`)
  and not a locally built spec (`local/spec-*`, always high risk).

Everything else is **high risk**. A pull request also waits while the cloud
agent is working on it (between its `copilot_work_started` and
`copilot_work_finished` timeline events, or right after a fix request), and
while a review thread blocks: human threads until resolved, Copilot threads
until the code under them changes. Once Copilot has reviewed the new head, the
gate resolves its outdated threads (the rulesets require resolved threads; the
new review raises again what still applies). A `CHANGES_REQUESTED` review from a human
fails the gate whatever the risk. A one-way door counts from the Merge Danger
line or from a breaking (`type!:`) title. The thresholds are plain constants with
tests next to them (`policy.test.cjs`, run by the `factory` CI job).

## What is where

| Piece | File | Role |
|---|---|---|
| Triage | `.github/workflows/triage.md` | New issue (or label `triage`): triage skill, never adds `ready-for-agent` |
| Spec | `.github/workflows/spec.md` | `/spec` comment: appends `## Spec`, labels `spec`, optional draft docs PR (glossary, ADR) |
| Plan | `.github/workflows/plan.md` | `spec:approved`: creates sub-issues with blocked-by edges, then runs dispatch |
| Dispatch | `.github/workflows/dispatch.yml`, `.github/factory/dispatch.cjs` | Assigns the cloud agent, closes merged tickets, opens integration PRs |
| Risk gate | `.github/workflows/risk-gate.yml`, `.github/factory/risk-gate.cjs` | Risk labels, `factory/risk-gate` status, automatic merge |
| PR labels | risk gate, `.github/labeler.yml` + `.github/workflows/labeler.yml`, `.github/release.yml` | Type labels from the linked ticket (or its spec) and the Conventional Commits title (`bug`, `enhancement`, `documentation`, `refactor`, `tests`, `ci`, `dependencies`), `door:one-way` from Merge Danger or a `!` title, path labels (`documentation`, `tests`, `ci`, `dependencies`, `factory`); release notes are grouped by them |
| Policy | `.github/factory/policy.cjs` (+ tests) | Pure rules shared by both scripts |
| Code review | `.github/skills/code-review/SKILL.md` | Copilot code review: Standards and Spec axes, reads the ticket and its parent spec |
| Review fix loop | `.github/factory/dispatch.cjs` (step 4) | `@copilot` addresses Copilot's comments, `FACTORY_MAX_FIX_ROUNDS` times, then `needs-human`; also `needs-human` when a round ends without a new commit |
| CI | `.github/workflows/ci.yml` | `test` (app) and `factory` (policy tests) |
| Implementer | `.github/agents/factory-implementer.agent.md` | Cloud agent: implement, tdd, code-review and pr skills, `Fixes #n` |
| Environment | `scripts/bootstrap.sh`, `.devcontainer/devcontainer.json` | One setup for Codespaces, the cloud agent (`copilot-setup-steps.yml`) and CI |
| Skills | `.github/skills/` | Matt Pocock's skills (MIT), see `.github/skills/README.md` |
| Skill config | `docs/agents/*.md` | Issue tracker, label vocabulary, domain docs |
| Rulesets | `docs/ruleset-main.json`, `docs/ruleset-factory.json` | Applied by the setup script |
| Cockpit | `.github/extensions/factory-cockpit/` | Copilot CLI canvas: queue, grilling, specs, tickets, PR risk |

## Setup

1. Install gh-aw v1.4.0: `gh extension install github/gh-aw --pin v1.4.0`.
2. Push the repository, including the compiled `.lock.yml` files.
3. Run the setup script (admin rights needed):

   ```bash
   gh auth refresh -s project   # only for --project
   GH_AW_AGENT_TOKEN=<token> scripts/setup-repo.sh --owner @you --project "Software factory"
   ```

   It creates the labels, enables squash merge and branch deletion, creates the
   `copilot-agent` environment (default branch only) with the token, applies
   both rulesets and creates and links the Project board.
4. Settings > Copilot: enable the cloud agent and turn off **Require approval
   for workflow runs** (otherwise CI never runs on the agent's PRs and nothing
   merges). See "Security" below for why this is acceptable.
5. In the Project's Workflows tab, turn on **Auto-add to project** for the
   repository; the built-in workflows then move items on close and merge.
6. Settings > Copilot > Code review: set the review effort to **Adaptive**.
   Open a test PR and check that the `[Spec]` comments quote the ticket; if
   they do not, add the GitHub MCP server under Copilot > MCP servers so the
   review can read issues (it is shared with the cloud agent).
7. Settings > Codespaces: add a **prebuild** for the default branch with
   `.devcontainer/devcontainer.json`, so review codespaces open in seconds, and
   set an idle timeout and a machine-type limit in your codespaces policies.

### The agent token

Assigning the cloud agent needs a **user** token. Create a fine-grained PAT
owned by a user with a Copilot licence, scoped to this repository, with read on
Metadata and read/write on Actions, Contents, Issues and Pull requests, and
store it only in the `copilot-agent` environment. `dispatch.yml` uses it to
assign Copilot, create `factory/spec-*` branches and open integration PRs (so
CI runs on them; events caused by `GITHUB_TOKEN` start no workflows). The
gh-aw workflows themselves bill through `copilot-requests: write`.

### Tunables (repository variables)

| Variable | Default | Effect |
|---|---|---|
| `FACTORY_MAX_ACTIVE` | 3 | Tickets the cloud agent works on at once |
| `FACTORY_MAX_FIX_ROUNDS` | 2 | Times the dispatcher asks `@copilot` to address a review before `needs-human` |
| `FACTORY_REQUIRED_CHECKS` | `test` | Checks that must pass before an automatic merge |
| `FACTORY_REQUIRE_COPILOT_REVIEW` | `true` | Wait for a Copilot review of the current head |
| `FACTORY_AUTO_MERGE_DEFAULT_BRANCH` | `true` | Allow automatic merges into the default branch |
| `FACTORY_AUTO_MERGE_INTEGRATION` | `false` | Treat integration PRs like any other PR |

## Using it

- **Small, clear request:** open the issue, read the triage comment, add
  `ready-for-agent`. Within a minute the issue gets 🚀 and `status:in-progress`;
  Copilot opens a draft PR. If the change is low risk it merges itself once CI
  and the Copilot review are green.
- **Big or vague request:** in the cockpit, press **Grill here** and answer
  the interview live; the session posts a `## Grilling summary` on the issue.
  Grilling is canvas-only: it is a fast back-and-forth that needs the code and
  docs at hand, which an issue thread cannot give. When only the reporter
  knows the answers, triage asks them on the issue (`needs-info`). Comment `/spec`,
  read the `## Spec` section, edit it if needed, then add `spec:approved`.
  Watch the sub-issues appear and get worked in dependency order on
  `factory/spec-N`; review the integration PR at the end.
- **Reviewing a risky PR:** the gate's comment has an **Open in Codespace**
  badge. The codespace checks out the PR branch, starts the app on port 3000
  and opens the preview, with the GitHub Pull Requests extension showing the
  review threads next to the code. Approve from there or on github.com.
- **From the terminal or a Codespace:** run `copilot` in the repository and
  open the cockpit canvas to triage, grill locally (the result is posted to the
  issue) and approve (see `.github/extensions/factory-cockpit/README.md`). In a
  Codespace the Copilot CLI is preinstalled; run `/login` once, and
  `gh auth login` if you need Project data (the codespace token is repository
  scoped).
- **Building a spec yourself:** on an approved spec, **Build here** in the
  cockpit labels it `lane:local` (the dispatcher stops handing its tickets to
  the cloud agent) and starts the `implement-spec` skill in your Copilot CLI
  session: subagents build the tickets in parallel worktrees and merge them
  into `local/spec-N` (outside the `factory/**` ruleset, so the session can
  push; it starts from `factory/spec-N` when cloud tickets already landed
  there, and merges it again before the PR is ready). The cockpit refuses
  while the cloud agent still works on a ticket of the spec. The result is one
  pull request into the default branch, always high risk, through the same
  checks and Copilot review. Use it when a spec is tightly coupled or you want to pair with the
  agent; the cloud lane stays the default because every ticket gets its own
  run, PR, review and gate.
- **Stuck?** `gh workflow run dispatch.yml` and
  `gh workflow run risk-gate.yml -f pr=<n>` re-run the sweeps; both are
  idempotent and also run on a schedule.

## Branch rulesets

`docs/ruleset-main.json` (default branch) and `docs/ruleset-factory.json`
(`factory/**`) require a pull request, resolved review threads, code owner
review (CODEOWNERS covers only the factory's own files) and the `test` and
`factory/risk-gate` checks, and enable automatic Copilot code review. No
approval count is required: the risk gate's status carries that decision, so
low-risk changes can merge without a human and high-risk ones cannot.

In a solo repository the only code owner cannot approve their own pull
request. `scripts/setup-repo.sh --admin-bypass` lets repository admins merge a
default-branch pull request past the ruleset (the "bypass rules" checkbox):
direct pushes stay blocked, and the bypass is visible on the pull request. Use
it for your own changes to the factory, after adding `human-approved`; leave it
off for team repositories.

## Security

- The agent token lives in an environment restricted to the default branch;
  code on the agent's branches cannot read it.
- `risk-gate.yml` uses `pull_request_target` and always checks out the default
  branch, so a pull request cannot change the rules it is judged by. Changes to
  `.github/` are high risk and need code owner review.
- Both required checks are pinned to the GitHub Actions app, so a PAT or
  another app cannot post them. Another *workflow* still could: `CI` runs the
  pull request's own definition (that is what `pull_request` means), so a branch
  that edits a workflow and asks for `statuses: write` could fake `test` or
  `factory/risk-gate` while it runs. Such a change touches `.github/`, so it is
  high risk and needs code owner review to merge, but the run itself happens
  first. The setup script makes read-only the default token permission, which
  does not stop a workflow from asking for more. To close this fully, publish
  the gate from a dedicated GitHub App and pin the check to it, or keep
  **Require approval for workflow runs** on and approve the agent's runs by hand.
- Copilot's PRs show the token owner as author. GitHub does not let authors
  approve their own PRs, which is why `human-approved` exists. When a writer
  adds it, the gate records a `factory/human-approval` status on that exact
  head; a later head has no such status, so the label is removed and has to
  be added again. In a team, prefer real approvals.
- The Copilot review requirement accepts only the
  `copilot-pull-request-reviewer[bot]` bot, and the gate asks for a new review
  whenever the current head has none.
- `ready-for-agent` and `spec:approved` are honoured only from people with write
  (respectively maintain) access or from the factory's own workflows.

## Known limits

- Copilot code review skills and MCP access are in public preview. The review
  picks `.github/skills/code-review` because of its name; if a review shows
  no `[Standards]` / `[Spec]` prefixes, it did not load the skill.
- Every fix round is another cloud agent session and another review: they
  bill as premium requests, hence the round cap.
- `lane:local` only stops new assignments. Tickets the cloud agent already
  started finish on their own.

- Closing keywords only work on the default branch, so the dispatcher closes
  tickets merged into `factory/spec-*` itself: it starts from open tickets
  assigned to Copilot and closes one only when a merged PR from a `copilot/*`
  branch of this repository into that ticket's own spec branch says
  `Fixes #n`.
- Pull requests opened by gh-aw with `GITHUB_TOKEN` (the docs PR from `/spec`)
  start no CI; push a commit or close and reopen them to start checks.
- Merge queues need an organization-owned repository.
- A stale `status:in-progress` ticket (agent gave up) counts against
  `FACTORY_MAX_ACTIVE` until a human removes the label.

After changing any `.github/workflows/*.md`, run `gh aw compile --actionlint`
and commit the `.lock.yml` files with it.

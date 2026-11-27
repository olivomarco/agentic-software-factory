# Software factory (advanced)

Issues become specs, specs become tickets, tickets become small pull requests
that the Copilot cloud agent writes and the factory merges on its own when
they are low risk. Humans decide **what** gets built (spec approval) and look
at **risky** changes; they no longer review every diff.

Everything runs on GitHub primitives: gh-aw agentic workflows, native
sub-issues and blocked-by dependencies, the Copilot cloud agent, Copilot code
review (with a repository skill), rulesets, environments, Codespaces and a
Project board. Three deterministic
workflows (`dispatch.yml`, `risk-gate.yml`, `project-sync.yml`) do the
bookkeeping without a model.

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
  |                  (to-tickets skill), then tickets:ready on the spec        |
  |                  no ticket starts before the whole breakdown exists        |
  v                                                                            v
dispatch.yml ..... assigns unblocked tickets to the cloud agent (max 3 at a time)
                   base = factory/spec-N for spec tickets, else the default branch
  v
cloud agent ...... draft PR: factory-implementer agent, implement + tdd skills
                   (diagnosing-bugs first on bugs),
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
| Plan | `.github/workflows/plan.md` | `spec:approved`: creates sub-issues with blocked-by edges, then labels the spec `tickets:ready`; dispatch runs when plan completes |
| Architecture scout | `.github/workflows/architecture-scout.md` | Weekly (or on demand): improve-codebase-architecture steps 1-2 on recent hot spots, posts up to 4 deepening candidates as one `[architecture]` issue (older ones closed). Proposes only; a human picks one with **Review here** in the cockpit |
| Scorecard | `.github/workflows/scorecard.yml`, `.github/factory/scorecard.cjs` | Weekly (Monday 06:17 UTC, or on demand): a `[factory] Scorecard` issue comparing the last 7 days with the 7 before — agent PRs merged and abandoned, success rate, merged by the factory vs handled by a human, fix rounds, retries, alerts, lead time, agent sessions, Copilot reviews, reverts. GitHub data only, no model; the previous scorecard is closed |
| Dispatch | `.github/workflows/dispatch.yml`, `.github/factory/dispatch.cjs` | Assigns the cloud agent, closes merged tickets, opens integration PRs |
| Risk gate | `.github/workflows/risk-gate.yml`, `.github/factory/risk-gate.cjs` | Risk labels, `factory/risk-gate` status, automatic merge |
| PR labels | risk gate, `.github/labeler.yml` + `.github/workflows/labeler.yml`, `.github/release.yml` | Type labels from the linked ticket (or its spec) and the Conventional Commits title (`bug`, `enhancement`, `documentation`, `refactor`, `tests`, `ci`, `dependencies`), `door:one-way` from Merge Danger or a `!` title, path labels (`documentation`, `tests`, `ci`, `dependencies`, `factory`); release notes are grouped by them |
| External timer | `scripts/factory-tick.sh`, `docs/external-timer.md` (+ Logic App definition) | Starts the dispatcher and gate sweeps every 10 minutes from a scheduler you trust; GitHub's own schedules stay as a fallback |
| Policy | `.github/factory/policy.cjs` (+ tests) | Pure rules shared by both scripts |
| Code review | `.github/skills/code-review/SKILL.md` | Copilot code review: Standards and Spec axes, reads the ticket and its parent spec |
| Review fix loop | `.github/factory/dispatch.cjs` (step 4) | `@copilot` addresses Copilot's comments, `FACTORY_MAX_FIX_ROUNDS` times, then `needs-human`; also `needs-human` when a round ends without a new commit |
| CI | `.github/workflows/ci.yml` | `test` (app) and `factory` (policy tests) |
| Tests bite | `.github/workflows/tests-bite.yml`, `.github/factory/tests-bite.cjs` | `tests-bite` check: the test files a PR adds or changes must fail on the base branch and pass on the PR. Source changes without a test fail; `docs`/`refactor`/`test`/`ci`/`build` titles, PRs without source changes and integration PRs skip |
| Evidence | `.github/workflows/evidence.yml` + `evidence-publish.yml`, `.github/factory/evidence*.cjs` | For PRs touching `frontend/` or `backend/`: Playwright screenshots of the base branch and the PR (phone and desktop, light and dark), stored on the `factory-evidence` branch and posted as one Before/After comment. Taken by CI, not by the agent |
| Implementer | `.github/agents/factory-implementer.agent.md` | Cloud agent: implement, tdd, code-review and pr skills, `Fixes #n` |
| Environment | `scripts/bootstrap.sh`, `.devcontainer/devcontainer.json` | One setup for Codespaces, the cloud agent (`copilot-setup-steps.yml`) and CI |
| Skills | `.github/skills/` | Matt Pocock's skills (MIT), see `.github/skills/README.md` |
| Skill config | `docs/agents/*.md` | Issue tracker, label vocabulary, domain docs |
| Rulesets | `docs/ruleset-main.json`, `docs/ruleset-factory.json` | Applied by the setup script |
| Cockpit | `.github/extensions/factory-cockpit/` | Copilot CLI canvas: queue, grilling, specs, tickets, PR risk; filters open and recently closed work |
| Project board | `.github/workflows/project-sync.yml`, `.github/factory/project-sync.cjs`, `scripts/setup-project.cjs` | Every issue and PR on the board, Status = factory stage (same rule as the cockpit), Kind, Risk |

## Setup

1. Install gh-aw v1.4.0: `gh extension install github/gh-aw --pin v1.4.0`.
2. Push the repository, including the compiled `.lock.yml` files.
3. Run the setup script (admin rights needed):

   ```bash
   gh auth refresh -s project   # only for --project
   GH_AW_AGENT_TOKEN=<token> FACTORY_PROJECT_TOKEN=<classic token> \
     scripts/setup-repo.sh --owner @you --project "Software factory"
   ```

   It creates the labels, enables squash merge and branch deletion, creates the
   `copilot-agent` environment (default branch only) with both tokens, applies
   the rulesets and creates, links and shapes the Project board (see "The
   Project board" below).
4. Settings > Copilot: enable the cloud agent. Turn off **Require approval for
   workflow runs** only if the script applied the `workflows: admins only` push
   ruleset (organization repositories). Otherwise leave it on and click
   **Approve and run workflows** on each agent push, after a look at the diff;
   until you do, CI does not run and nothing merges. See "Security" below.
5. Settings > Copilot > Code review: set the review effort to **Adaptive**.
   Open a test PR and check that the `[Spec]` comments quote the ticket; if
   they do not, add the GitHub MCP server under Copilot > MCP servers so the
   review can read issues (it is shared with the cloud agent).
6. Settings > Codespaces: add a **prebuild** for the default branch with
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

### The Project board

`--project` gives the board the factory's shape (from `PROJECT_FIELDS` in
`policy.cjs`, applied by `scripts/setup-project.cjs`):

- **Status** options become the stages: Needs attention, Triage, Needs info,
  Spec, Spec approved, Ready for agent, In progress, In review, Needs human,
  Done, Won't fix. They follow the same rule as the cockpit's queue.
- **Kind** (Spec, Ticket, Bug, Enhancement, Pull request, Report, Other) and
  **Risk** (Low, High, from the risk gate's labels).
- Views: **Factory** (board by Status), **Needs a human**, **Specs** (with
  parent issue and sub-issue progress) and **Pull requests**.

`project-sync.yml` keeps it current: it adds every issue and pull request and
sets the three fields from labels and state, after every issue event, after
each factory workflow finishes, and hourly. It only writes what changed. Run
`gh workflow run project-sync.yml -f backfill=true` to take the whole history.
The project's built-in workflows (auto-add, item closed) are not needed; leave
them off so they do not fight the sync over Status.

The sync needs `FACTORY_PROJECT_TOKEN` in the `copilot-agent` environment: a
**classic** token with the `project` scope (add `repo` for a private
repository). Fine-grained tokens and GitHub Apps cannot write user-owned
projects; for an organization project, a GitHub App token with Projects
read/write works too.

### Tunables (repository variables)

| Variable | Default | Effect |
|---|---|---|
| `FACTORY_MAX_ACTIVE` | 3 | Tickets the cloud agent works on at once |
| `FACTORY_MAX_FIX_ROUNDS` | 2 | Times the dispatcher asks `@copilot` to address a review before `needs-human` |
| `FACTORY_REQUIRED_CHECKS` | `test,tests-bite` | Checks that must pass before an automatic merge |
| `FACTORY_START_CMD` | `npm start` | Command the Evidence workflow starts the app with (it sets `PORT`) |
| `FACTORY_EVIDENCE_PATHS` | `/` | Comma-separated pages the Evidence workflow captures |
| `FACTORY_TEST_CMD` | `node --test` | Command `tests-bite` runs with one test file appended (for example `npx jest` or `npx vitest run`) |
| `FACTORY_REQUIRE_COPILOT_REVIEW` | `true` | Wait for a Copilot review of the current head |
| `FACTORY_AUTO_MERGE_DEFAULT_BRANCH` | `true` | Allow automatic merges into the default branch |
| `FACTORY_AUTO_MERGE_INTEGRATION` | `false` | Treat integration PRs like any other PR |
| `FACTORY_MAX_AGENT_RETRIES` | 1 | Automatic retries of a stalled or failed agent session before the ticket goes to a human |
| `FACTORY_AGENT_NO_PR_MINUTES` | 30 | Minutes after assignment without an agent PR before the session counts as stalled |
| `FACTORY_AGENT_SESSION_MINUTES` | 90 | Minutes an agent session may run before it counts as stalled |

## Using it

- **Small, clear request:** open the issue, read the triage comment, add
  `ready-for-agent`. Within a minute the issue gets 🚀 and `status:in-progress`;
  Copilot opens a draft PR. If the change is low risk it merges itself once CI
  and the Copilot review are green.
- **Big or vague request:** in the cockpit, press **Grill here** and answer
  the interview live; the session posts a `## Grilling summary` on the issue.
  When a state-model or UI question needs to be seen, it offers a throwaway
  prototype (`prototype` skill); the verdict lands in the summary.
  Grilling is canvas-only: it is a fast back-and-forth that needs the code and
  docs at hand, which an issue thread cannot give. When only the reporter
  knows the answers, triage asks them on the issue (`needs-info`). Comment `/spec`,
  read the `## Spec` section, edit it if needed, then add `spec:approved`.
  Watch the sub-issues appear; once all are published the spec gets
  `tickets:ready` and they are worked in dependency order on
  `factory/spec-N`; review the integration PR at the end.
- **Keeping the code easy to change:** each week the architecture scout posts
  an `[architecture]` issue with deepening candidates (shallow modules found
  in recent hot spots). In the cockpit press **Review here** on it, or the
  toolbar's **Architecture review** for a fresh scan: Copilot CLI writes the
  HTML report, grills you through the candidate you pick and files the agreed
  refactor as an issue; comment `/spec` on it and it follows the normal path.
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
  idempotent and also run on a schedule (see below).

## When things fail

Runs fail, often for infrastructure reasons. The factory retries once, then
hands the work to a human with a label; the cockpit gathers it all under
**Needs attention**.

| What fails | What happens |
|---|---|
| Cloud agent session (no PR after 30 min, runs over 90 min, finishes with an error or leaves its PR titled `[WIP]`, PR closed unmerged) | The gate never merges a Copilot PR still titled `[WIP]`. The dispatcher cancels the agent's stuck run, if any (a hung session blocks new `@copilot` requests), then retries once: `@copilot` comment on the open PR, or unassign and re-assign. A second failure unassigns Copilot, swaps `status:in-progress` for `agent:failed` + `ready-for-human` and labels the PR `needs-human`. The slot and the tickets blocked by it are freed for a person. **Retry agent** in the cockpit re-adds `ready-for-agent`, which resets the retry budget |
| CI (`startup_failure`, `timed_out`, or a failed job with no failed step) | The risk gate re-runs the failed jobs once (first attempt only). Real test failures are left to the fix loop |
| Plan (a ticket could not be published, or the run failed) | The spec does not get `tickets:ready`, so none of its tickets start. Fix or delete the tickets, then add `tickets:ready` yourself to release them |
| Triage | An issue without a triage label after 1 h gets `triage` re-added (one retry), then `factory:failure` and a comment. **Re-triage** in the cockpit tries again |
| Any gh-aw workflow | gh-aw opens an `[aw] … failed` issue; the dispatcher labels it `factory:failure` |
| The sweeps themselves | Each ticket, spec and PR is handled on its own: one error no longer stops the sweep, and the run fails at the end listing every error |

Scheduled runs are best effort: GitHub delays them and may skip them, and on a
quiet repository they may not run for hours. Events (labels, merges, CI) and the
cockpit's **Dispatch** button drive the factory: a merged pull request starts
the dispatcher at once (through the risk gate), and so does a finished cloud
agent session when GitHub delivers that `workflow_run` event. For unattended
operation add the external timer (`docs/external-timer.md`); the schedule is
then the last safety net.
The cockpit also lists every workflow whose latest run in the last 24 hours
failed, with **Re-run failed jobs**.

Re-running a gh-aw run partway is safe for triage, `/spec` and dispatch, which
redo their work. `plan` stops when the spec already has sub-issues, but
re-running only its `safe_outputs` job after it created some tickets can
create duplicates; re-run the whole workflow instead.

## Branch rulesets

`docs/ruleset-main.json` (default branch) and `docs/ruleset-factory.json`
(`factory/**`) require a pull request, resolved review threads, code owner
review (CODEOWNERS covers only the factory's own files) and the `test`,
`tests-bite` and `factory/risk-gate` checks, and enable automatic Copilot code review. On
`factory/**` the checks are not enforced on branch creation
(`do_not_enforce_on_create`); otherwise the dispatcher cannot create
`factory/spec-N` (422 "Reference update failed"). No
approval count is required: the risk gate's status carries that decision, so
low-risk changes can merge without a human and high-risk ones cannot.

`docs/ruleset-workflows.json` is a **push** ruleset: only repository admins
may push a change under `.github/workflows/`, on any branch. GitHub accepts push
rulesets on organization-owned repositories only; on a personal repository the
script says so and skips it. Change a workflow yourself, on your own branch.

In a solo repository the only code owner cannot approve their own pull
request. `scripts/setup-repo.sh --admin-bypass` lets repository admins merge a
default-branch pull request past the ruleset (the "bypass rules" checkbox):
direct pushes stay blocked, and the bypass is visible on the pull request. Use
it for your own changes to the factory, after adding `human-approved`; leave it
off for team repositories.

## Security

- The agent token lives in an environment restricted to the default branch;
  code on the agent's branches cannot read it.
- Evidence is split in two: `evidence.yml` runs the pull request's code with a
  read-only token and only uploads an artifact; `evidence-publish.yml` runs the
  default branch's script with a write token and accepts only PNG files with
  the expected names, for the pull request whose head is still the one that
  was photographed.
- `risk-gate.yml` uses `pull_request_target` and always checks out the default
  branch, so a pull request cannot change the rules it is judged by. Changes to
  `.github/` are high risk and need code owner review.
- The required checks are pinned to the GitHub Actions app, so a PAT or
  another app cannot post them. Another *workflow* still could: `CI` runs the
  pull request's own definition (that is what `pull_request` means), so a branch
  that edits a workflow and asks for `statuses: write` could fake `test` or
  `factory/risk-gate` while it runs. Such a change touches `.github/`, so it is
  high risk and needs code owner review to merge, but the run itself happens
  first, with a token that can write to the repository and post the statuses
  of *other* pull requests. The setup script makes read-only the default token
  permission, which does not stop a workflow from asking for more. Two ways to
  close this:
  - organization repository: the `workflows: admins only` push ruleset stops
    the agent from pushing workflow changes at all, so its runs only ever use
    the default branch's definitions (CI: read-only token, no secrets). Then
    turning off **Require approval for workflow runs** is safe;
  - personal repository (no push rulesets): keep **Require approval for
    workflow runs** on and approve the agent's runs by hand, after checking the
    diff touches nothing under `.github/workflows/`.
  Runs triggered by Copilot code review's comments (`pull_request_review`,
  actor `Copilot`) also wait for approval; ignore them: the gate's status
  comes from its other runs.
- There are no repository-level secrets. The gh-aw workflows authenticate with
  the run's own token (`copilot-requests: write`), and both tokens live in the
  `copilot-agent` environment. A `COPILOT_GITHUB_TOKEN` repository secret left
  from older gh-aw versions is unused: delete it.
- Copilot's PRs show the token owner as author. GitHub does not let authors
  approve their own PRs, which is why `human-approved` exists. When a writer
  adds it, the gate records a `factory/human-approval` status on that exact
  head; a later head has no such status, so the label is removed and has to
  be added again. In a team, prefer real approvals.
- The Copilot review requirement accepts only the
  `copilot-pull-request-reviewer[bot]` bot, and the gate asks for a new review
  whenever the current head has none.
- `ready-for-agent` and `spec:approved` are honoured only from people with write
  (respectively maintain) access or from the factory's own workflows;
  `tickets:ready` only from people with write access or from plan.
- The order spec, then tickets, then code is enforced by the dispatcher: a
  spec issue is never built itself, and a spec's tickets wait for
  `spec:approved`, `tickets:ready` and the end of every plan run.

## Known limits

- Copilot code review skills and MCP access are in public preview. The review
  picks `.github/skills/code-review` because of its name; if a review shows
  no `[Standards]` / `[Spec]` prefixes, it did not load the skill.
- Every fix round is another cloud agent session and another review: they
  bill as premium requests, hence the round cap.
- `tests-bite` reruns whole test files, not single tests: a changed file
  counts as biting when any of its tests fails on the base branch. A failing
  `test` or `tests-bite` check is not sent back to the agent; the PR waits
  for a human (the gate shows which check is missing).
- The `factory-evidence` branch keeps every screenshot ever published; delete
  it now and then (`git push origin --delete factory-evidence`), older
  comments then show broken images. Screenshots use the app's synthetic
  data, so they show layout and styling, not real content.
- The scorecard measures lead time from PR opened to merged (not from
  ticket to merged), counts reverts by `Revert` commit titles on the default
  branch, and counts a merged PR as human-handled when it carries `risk:high`,
  `needs-human` or `human-approved`. It reads at most the last 14 days.
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

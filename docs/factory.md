# Software factory (advanced)

Issues become specs, specs become tickets, tickets become small pull requests
that the Copilot cloud agent writes and the factory merges on its own when
they are low risk. Humans decide **what** gets built (spec approval) and look
at **risky** changes; they no longer review every diff.

Everything runs on GitHub primitives: gh-aw agentic workflows, native
sub-issues and blocked-by dependencies, the Copilot cloud agent, Copilot code
review, rulesets, environments and a Project board. Two deterministic
workflows (`dispatch.yml`, `risk-gate.yml`) do the bookkeeping without a model.

```text
issue opened
  v
triage.md ........ category + state labels, agent brief or questions (triage skill)
  |
  |-- small and clear -> maintainer adds ready-for-agent ----------------------.
  |                                                                            |
  |-- big or vague:                                                            |
  |   /grill ....... one interview round per comment (grill-with-docs skill)   |
  |   /spec ........ ## Spec appended to the issue, label spec (to-spec skill) |
  |   HUMAN GATE: maintainer adds spec:approved                                |
  |   plan.md ...... sub-issues with blocked-by edges, ready-for-agent         |
  |                  (to-tickets skill)                                        |
  v                                                                            v
dispatch.yml ..... assigns unblocked tickets to the cloud agent (max 3 at a time)
                   base = factory/spec-N for spec tickets, else the default branch
  v
cloud agent ...... draft PR (factory-implementer agent, tests, screenshots, "Fixes #n")
  v
risk-gate.yml .... marks it ready, asks for a Copilot review, labels risk:low / risk:high,
                   publishes the factory/risk-gate status
  |-- risk:low  + CI green + Copilot reviewed + no open threads -> squash merge
  |-- risk:high -> HUMAN: approve (or add human-approved) -> merge
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

Runs never wait for a human: every stage reacts to an event (comment, label,
review) and exits, so the factory survives a weekend of nobody looking.

## Risk policy (`.github/factory/policy.cjs`)

A pull request is **low risk** when all of these hold:

- at most 300 changed lines and 12 files;
- it touches none of `.github/`, `package.json` / `package-lock.json`,
  `AGENTS.md`, `CODING_STANDARDS.md`, `docs/adr/` (renames count on both sides);
- it carries no `hold` label;
- its branch lives in this repository (not a fork);
- it is not a spec integration pull request (`FACTORY_AUTO_MERGE_INTEGRATION`).

Everything else is **high risk**. A `CHANGES_REQUESTED` review from a human
fails the gate whatever the risk. The thresholds are plain constants with
tests next to them (`policy.test.cjs`, run by the `factory` CI job).

## What is where

| Piece | File | Role |
|---|---|---|
| Triage | `.github/workflows/triage.md` | New issue (or label `triage`): triage skill, never adds `ready-for-agent` |
| Grill | `.github/workflows/grill.md` | `/grill` comment: one round of questions, with recommended answers |
| Spec | `.github/workflows/spec.md` | `/spec` comment: appends `## Spec`, labels `spec`, optional draft docs PR (glossary, ADR) |
| Plan | `.github/workflows/plan.md` | `spec:approved`: creates sub-issues with blocked-by edges, then runs dispatch |
| Dispatch | `.github/workflows/dispatch.yml`, `.github/factory/dispatch.cjs` | Assigns the cloud agent, closes merged tickets, opens integration PRs |
| Risk gate | `.github/workflows/risk-gate.yml`, `.github/factory/risk-gate.cjs` | Risk labels, `factory/risk-gate` status, automatic merge |
| Policy | `.github/factory/policy.cjs` (+ tests) | Pure rules shared by both scripts |
| Spec check | `.github/workflows/spec-check.md` | Advisory PR comment: ticket and standards fit, `npm test` |
| CI | `.github/workflows/ci.yml` | `test` (app) and `factory` (policy tests) |
| Implementer | `.github/agents/factory-implementer.agent.md` | Cloud agent prompt: parent spec, small PRs, screenshots, `Fixes #n` |
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
| `FACTORY_REQUIRED_CHECKS` | `test` | Checks that must pass before an automatic merge |
| `FACTORY_REQUIRE_COPILOT_REVIEW` | `true` | Wait for a Copilot review of the current head |
| `FACTORY_AUTO_MERGE_DEFAULT_BRANCH` | `true` | Allow automatic merges into the default branch |
| `FACTORY_AUTO_MERGE_INTEGRATION` | `false` | Treat integration PRs like any other PR |

## Using it

- **Small, clear request:** open the issue, read the triage comment, add
  `ready-for-agent`. Within a minute the issue gets 🚀 and `status:in-progress`;
  Copilot opens a draft PR. If the change is low risk it merges itself once CI
  and the Copilot review are green.
- **Big or vague request:** comment `/grill`, answer the questions in a
  comment, repeat until the grill says the frontier is empty. Comment `/spec`,
  read the `## Spec` section, edit it if needed, then add `spec:approved`.
  Watch the sub-issues appear and get worked in dependency order on
  `factory/spec-N`; review the integration PR at the end.
- **From the terminal:** open the cockpit canvas in Copilot CLI and run the
  grilling locally; the result is posted to the issue (see
  `.github/extensions/factory-cockpit/README.md`).
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

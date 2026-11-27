const test = require("node:test");
const assert = require("node:assert");
const {
  issueStage,
  PROJECT_FIELDS,
  projectValues,
  classifyRisk,
  closingRefs,
  isCopilotDone,
  humanApprovals,
  isSpecBranch,
  mergeDangerDoor,
  describeLabels,
  copilotBusy,
  agentHealth,
  recoveryAction,
  isInfraFailure,
  triageRetry,
  blockingThreads,
  fixLoopAction,
  parseFixRequest,
} = require("./policy.cjs");

const file = (filename, additions = 10, deletions = 0) => ({ filename, additions, deletions });

test("small change outside sensitive paths is low risk", () => {
  const r = classifyRisk({ files: [file("frontend/app.js", 40, 5), file("frontend/logic.test.js", 30)] });
  assert.deepStrictEqual([r.risk, r.lines], ["low", 75]);
});

test("size, file count, sensitive paths, renames and hold make it high risk", () => {
  assert.match(classifyRisk({ files: [file("backend/app.js", 301)] }).reasons[0], /301 changed lines/);
  assert.match(classifyRisk({ files: Array.from({ length: 13 }, (_, i) => file(`f${i}.js`, 1)) }).reasons[0], /13 files/);
  assert.match(classifyRisk({ files: [file(".github/workflows/ci.yml", 1)] }).reasons[0], /\.github\/workflows\/ci\.yml/);
  const renamed = { ...file("evil.yml", 0), previous_filename: ".github/workflows/ci.yml" };
  assert.strictEqual(classifyRisk({ files: [renamed] }).risk, "high");
  assert.strictEqual(classifyRisk({ files: [file("scripts/bootstrap.sh", 1)] }).risk, "high");
  assert.strictEqual(classifyRisk({ files: [file(".devcontainer/devcontainer.json", 1)] }).risk, "high");
  assert.strictEqual(classifyRisk({ files: [file("a.js")], labels: ["hold"] }).risk, "high");
  assert.strictEqual(classifyRisk({ files: [file("a.js")], labels: ["needs-human"] }).risk, "high");
});

test("a one-way door raises the risk, a two-way door never lowers it", () => {
  assert.strictEqual(mergeDangerDoor("## Merge Danger\n\n**Door:** One-way\n"), "one-way");
  assert.strictEqual(mergeDangerDoor("**Door:** two way"), "two-way");
  assert.strictEqual(mergeDangerDoor("no section"), null);
  assert.match(classifyRisk({ files: [file("a.js")], door: "one-way" }).reasons[0], /one-way door/);
  assert.strictEqual(classifyRisk({ files: [file("a.js", 400)], door: "two-way" }).risk, "high");
});

test("the agent is busy between work_started and work_finished, or right after a fix request", () => {
  const ev = (event, created_at) => ({ event, created_at });
  const now = Date.parse("2026-01-01T12:00:00Z");
  const done = [ev("copilot_work_started", "2026-01-01T10:00:00Z"), ev("copilot_work_finished", "2026-01-01T10:30:00Z")];
  assert.strictEqual(copilotBusy(done, { now }), false);
  assert.strictEqual(copilotBusy([...done, ev("copilot_work_started", "2026-01-01T11:00:00Z")], { now }), true);
  assert.strictEqual(copilotBusy(done, { now, requestedAt: ["2026-01-01T11:50:00Z"] }), true);
  assert.strictEqual(copilotBusy(done, { now, requestedAt: ["2026-01-01T11:00:00Z"] }), false, "stale request");
  assert.strictEqual(copilotBusy(done, { now, requestedAt: ["2026-01-01T10:10:00Z"] }), false, "already handled");
  assert.strictEqual(copilotBusy([ev("copilot_work_started", "2026-01-01T08:00:00Z")], { now }), false, "a session that never finished");
});

test("agent health: stuck, failed and closed work is noticed, slow work is not", () => {
  const ev = (event, created_at) => ({ event, created_at });
  const at = (hhmm) => Date.parse(`2026-01-01T${hhmm}:00Z`);
  const now = at("12:00");
  const pr = (timeline, extra = {}) => ({ title: "Wrap titles", draft: false, timeline, ...extra });
  const status = (args) => agentHealth({ now, ...args }).status;
  assert.strictEqual(status({ since: at("11:45") }), "ok", "no PR yet, recently assigned");
  assert.strictEqual(status({ since: at("11:00") }), "stalled", "no PR after 30 minutes");
  assert.strictEqual(status({ since: at("11:00"), assigned: false }), "unassigned");
  assert.strictEqual(status({ since: at("11:00"), closedPr: { number: 7 } }), "closed");
  assert.strictEqual(status({ since: at("10:00"), pr: pr([ev("copilot_work_started", "2026-01-01T11:10:00Z")]) }), "ok", "a 50-minute session");
  assert.strictEqual(status({ since: at("10:00"), pr: pr([ev("copilot_work_started", "2026-01-01T10:00:00Z")]) }), "stalled");
  const failed = [ev("copilot_work_started", "2026-01-01T10:00:00Z"), ev("copilot_work_finished_failure", "2026-01-01T10:20:00Z")];
  assert.strictEqual(status({ since: at("09:59"), pr: pr(failed) }), "failed");
  assert.strictEqual(status({ since: at("11:50"), pr: pr(failed) }), "ok", "retried recently");
  assert.strictEqual(status({ since: at("11:00"), pr: pr(failed) }), "stalled", "the retry was never picked up");
  const done = [ev("copilot_work_started", "2026-01-01T10:00:00Z"), ev("copilot_work_finished", "2026-01-01T10:20:00Z")];
  assert.strictEqual(status({ since: at("09:59"), pr: pr(done) }), "ok");
  assert.strictEqual(status({ since: at("09:59"), pr: pr(done, { draft: true, title: "[WIP] Wrap titles" }) }), "stalled", "gave up as WIP");
});

test("recovery retries once, but never overrides a human", () => {
  assert.strictEqual(recoveryAction({ status: "ok" }, { retries: 0 }), "none");
  assert.strictEqual(recoveryAction({ status: "failed" }, { retries: 0 }), "retry");
  assert.strictEqual(recoveryAction({ status: "stalled" }, { retries: 1 }), "handoff");
  assert.strictEqual(recoveryAction({ status: "closed" }, { retries: 0 }), "handoff");
  assert.strictEqual(recoveryAction({ status: "unassigned" }, { retries: 0 }), "handoff");
});

test("CI failures without a failing step count as infrastructure", () => {
  const job = (conclusion, steps = []) => ({ conclusion, steps: steps.map((c) => ({ conclusion: c })) });
  assert.strictEqual(isInfraFailure({ conclusion: "startup_failure" }), true);
  assert.strictEqual(isInfraFailure({ conclusion: "failure" }, [job("failure", ["success", "failure"])]), false, "a failing test");
  assert.strictEqual(isInfraFailure({ conclusion: "failure" }, [job("failure", ["success", "cancelled"])]), true, "lost runner");
  assert.strictEqual(isInfraFailure({ conclusion: "failure" }, [job("success"), job("timed_out")]), true);
  assert.strictEqual(isInfraFailure({ conclusion: "cancelled" }, []), false, "superseded run");
});

test("triage is retried once on issues it never labelled", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const base = { labels: [], createdAt: "2026-01-01T10:00:00Z", retries: 0, now };
  assert.strictEqual(triageRetry(base), "retry");
  assert.strictEqual(triageRetry({ ...base, labels: ["bug", "needs-triage"] }), "none");
  assert.strictEqual(triageRetry({ ...base, createdAt: "2026-01-01T11:30:00Z" }), "none", "still within the grace period");
  assert.strictEqual(triageRetry({ ...base, labels: ["triage"], triageLabelledAt: "2026-01-01T11:30:00Z", retries: 1 }), "none");
  assert.strictEqual(triageRetry({ ...base, retries: 1 }), "giveup");
});

test("outdated Copilot threads stop blocking, human threads do not", () => {
  const threads = [
    { isResolved: false, isOutdated: true, author: "copilot-pull-request-reviewer" },
    { isResolved: false, isOutdated: false, author: "copilot-pull-request-reviewer" },
    { isResolved: false, isOutdated: true, author: "ann" },
    { isResolved: true, isOutdated: false, author: "bob" },
  ];
  assert.deepStrictEqual(blockingThreads(threads).map((t) => t.author), ["copilot-pull-request-reviewer", "ann"]);
});

test("fix-request markers must be complete", () => {
  const sha = "a".repeat(40);
  assert.deepStrictEqual(parseFixRequest(`x\n<!-- factory:fix-request sha=${sha} round=2 -->`), { sha, round: 2 });
  assert.strictEqual(parseFixRequest("<!-- factory:fix-request sha=abc round=1 -->"), null);
  assert.strictEqual(parseFixRequest(null), null);
});

test("the fix loop asks Copilot at most maxRounds times, then escalates", () => {
  const base = { reviewedHead: true, copilotThreads: 2, busy: false, requestedForHead: false, rounds: 0 };
  assert.strictEqual(fixLoopAction(base), "request");
  assert.strictEqual(fixLoopAction({ ...base, rounds: 2 }), "escalate");
  assert.strictEqual(fixLoopAction({ ...base, copilotThreads: 0 }), "none");
  assert.strictEqual(fixLoopAction({ ...base, busy: true }), "none");
  assert.strictEqual(fixLoopAction({ ...base, requestedForHead: true }), "escalate", "attempt ended without a new commit");
  assert.strictEqual(fixLoopAction({ ...base, requestedForHead: true, busy: true }), "none", "attempt still running");
  assert.strictEqual(fixLoopAction({ ...base, reviewedHead: false }), "none");
});

test("closingRefs finds same-repo closing keywords only", () => {
  const body = "Fixes #12\ncloses: #3, resolves other/repo#9, Resolves me/app#4 and refs #7";
  assert.deepStrictEqual(closingRefs(body, "me/app").sort(), [12, 3, 4].sort());
  assert.deepStrictEqual(closingRefs(null, "me/app"), []);
});

test("Copilot is done when the [WIP] prefix is gone", () => {
  assert.strictEqual(isCopilotDone({ head: { ref: "copilot/x" }, title: "[WIP] Add toggle" }), false);
  assert.strictEqual(isCopilotDone({ head: { ref: "copilot/x" }, title: "Add toggle" }), true);
  assert.strictEqual(isCopilotDone({ head: { ref: "feature/x" }, title: "Add toggle" }), false);
});

test("approvals count only on the head, from humans other than the author", () => {
  const u = (login, type = "User") => ({ login, type });
  const reviews = [
    { user: u("ann"), state: "APPROVED", commit_id: "old" },
    { user: u("bob"), state: "APPROVED", commit_id: "head" },
    { user: u("me"), state: "APPROVED", commit_id: "head" },
    { user: u("bot", "Bot"), state: "APPROVED", commit_id: "head" },
    { user: u("cat"), state: "CHANGES_REQUESTED", commit_id: "head" },
    { user: u("dan"), state: "CHANGES_REQUESTED", commit_id: "old" },
    { user: u("dan"), state: "APPROVED", commit_id: "head" },
  ];
  assert.deepStrictEqual(humanApprovals(reviews, { headSha: "head", author: "me" }), { approvers: ["bob", "dan"], blockers: ["cat"] });
});

test("spec branches are recognised by prefix", () => {
  assert.strictEqual(isSpecBranch("factory/spec-12"), true);
  assert.strictEqual(isSpecBranch("main"), false);
});

test("describeLabels combines ticket type, conventional title and door", () => {
  const r = describeLabels({ title: "[WIP] fix(cart): round totals", body: "**Door:** two-way", issueLabels: ["enhancement", "ready-for-agent"] });
  assert.deepStrictEqual([r.add.sort(), r.oneWay], [["bug", "enhancement"], false]);
  assert.deepStrictEqual(describeLabels({ title: "feat!: drop v1 API" }), { add: ["enhancement", "door:one-way"], oneWay: true });
  assert.deepStrictEqual(describeLabels({ title: "Spec #4: dark mode", body: "**Door:** one-way" }).add, ["door:one-way"]);
  assert.deepStrictEqual(describeLabels({ title: "chore: tidy" }).add, []);
});

test("project values follow the factory's stages", () => {
  const issue = (labels, extra = {}) => projectValues({ state: "open", title: "x", labels: labels.map((name) => ({ name })), ...extra });
  assert.deepStrictEqual(issue([]), { Status: "Triage", Kind: "Other", Risk: null });
  assert.strictEqual(issue(["bug", "status:in-progress"], { parent_issue_url: "u" }).Kind, "Ticket");
  assert.strictEqual(issue(["bug", "agent:failed", "ready-for-human"]).Status, "Needs attention");
  assert.deepStrictEqual(issue(["spec:approved"], { sub_issues_summary: { total: 2 } }), { Status: "Spec approved", Kind: "Spec", Risk: null });
  assert.strictEqual(issue(["factory:failure"], { title: "[aw] Triage failed" }).Kind, "Report");
  assert.strictEqual(issue(["bug"], { state: "closed", state_reason: "completed" }).Status, "Done");
  assert.strictEqual(issue(["bug"], { state: "closed", state_reason: "not_planned" }).Status, "Won't fix");

  const pr = (labels, extra = {}) => projectValues({ state: "open", title: "Fix", labels, pull_request: { merged_at: null }, ...extra });
  assert.deepStrictEqual(pr(["risk:low"]), { Status: "In review", Kind: "Pull request", Risk: "Low" });
  assert.strictEqual(pr(["risk:high"]).Status, "Needs human");
  assert.strictEqual(pr(["risk:high", "human-approved"]).Status, "In review");
  assert.strictEqual(pr([], { title: "[WIP] Fix" }).Status, "In progress");
  assert.strictEqual(pr(["risk:high"], { state: "closed", pull_request: { merged_at: "t" } }).Status, "Done");
  assert.strictEqual(pr([], { state: "closed" }).Status, "Won't fix");

  // Every value the sync can write exists as an option.
  const options = (f) => PROJECT_FIELDS[f].map(([n]) => n);
  for (const labels of [["agent:failed"], [], ["needs-info"], ["spec"], ["spec:approved"], ["ready-for-agent"], ["status:in-progress"], ["ready-for-human"], ["wontfix"]]) {
    assert.ok(options("Status").includes(issue(labels).Status), labels.join());
  }
  assert.strictEqual(issueStage(["ready-for-agent", "status:in-progress"]), "in-progress");
});

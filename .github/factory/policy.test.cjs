const test = require("node:test");
const assert = require("node:assert");
const { classifyRisk, closingRefs, isCopilotDone, humanApprovals, isSpecBranch } = require("./policy.cjs");

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
  assert.strictEqual(classifyRisk({ files: [file("a.js")], labels: ["hold"] }).risk, "high");
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

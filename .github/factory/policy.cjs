// Pure rules shared by dispatch.cjs and risk-gate.cjs. No GitHub calls here,
// so the policy can be unit tested (policy.test.cjs) and reviewed on its own.

const LIMITS = { maxLines: 300, maxFiles: 12 };

// Paths whose changes always need a human, whatever their size.
const SENSITIVE = [
  /^\.github\//,
  /^\.devcontainer\//,
  /^scripts\//,
  /^package(-lock)?\.json$/,
  /^AGENTS\.md$/,
  /^CODING_STANDARDS\.md$/,
  /^docs\/adr\//,
];

const SPEC_BRANCH_PREFIX = "factory/spec-";
// Integration branch of a spec built locally with implement-spec (lane:local).
// Outside the factory/** ruleset so the local session can push it.
const LOCAL_SPEC_BRANCH_PREFIX = "local/spec-";

function specBranch(specNumber) {
  return `${SPEC_BRANCH_PREFIX}${specNumber}`;
}

function isSpecBranch(ref) {
  return typeof ref === "string" && ref.startsWith(SPEC_BRANCH_PREFIX);
}

function isLocalSpecBranch(ref) {
  return typeof ref === "string" && ref.startsWith(LOCAL_SPEC_BRANCH_PREFIX);
}

// Labels that always send a pull request to a human.
const HOLD_LABELS = ["hold", "needs-human"];

// files: [{ filename, previous_filename?, additions, deletions }], labels: [string],
// door: the author's Merge Danger door ("one-way" / "two-way" / null). The door
// can only raise the risk: a two-way door never lowers it.
function classifyRisk({ files, labels = [], door = null, limits = LIMITS }) {
  const reasons = [];
  const lines = files.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  if (lines > limits.maxLines) reasons.push(`${lines} changed lines (limit ${limits.maxLines})`);
  if (files.length > limits.maxFiles) reasons.push(`${files.length} files (limit ${limits.maxFiles})`);
  const paths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const sensitive = [...new Set(paths.filter((p) => SENSITIVE.some((re) => re.test(p))))];
  if (sensitive.length) reasons.push(`sensitive paths: ${sensitive.join(", ")}`);
  for (const l of HOLD_LABELS) if (labels.includes(l)) reasons.push(`\`${l}\` label`);
  if (door === "one-way") reasons.push("author marked it a one-way door");
  return { risk: reasons.length ? "high" : "low", reasons, lines };
}

// Issue numbers a PR body closes: "Fixes #12", "closes: #3", "Resolves owner/repo#4" (same repo only).
function closingRefs(body, repoFullName) {
  const refs = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
  for (const m of (body || "").matchAll(re)) {
    if (!m[1] || m[1].toLowerCase() === String(repoFullName).toLowerCase()) refs.add(Number(m[2]));
  }
  return [...refs];
}

// The **Door:** line of the pr skill's Merge Danger section.
function mergeDangerDoor(body) {
  const m = /\*\*Door:?\*\*:?\s*(one|two)[- ]way\b/i.exec(body || "");
  return m ? `${m[1].toLowerCase()}-way` : null;
}

// Labels describing what a pull request is. Path-based ones (documentation,
// tests, ci, dependencies, factory) come from actions/labeler instead.
const TYPE_LABELS = ["bug", "enhancement", "documentation"];
const TITLE_TYPES = {
  feat: "enhancement",
  perf: "enhancement",
  fix: "bug",
  docs: "documentation",
  refactor: "refactor",
  test: "tests",
  ci: "ci",
  build: "dependencies",
  deps: "dependencies",
};
const ONE_WAY_LABEL = "door:one-way";

// Conventional Commits title ("fix(cart): ...", "feat!: ...", "[WIP] docs: ...").
function titleType(title) {
  const m = /^(?:\[WIP\]\s*)?([a-z]+)(?:\([^)]*\))?(!)?:\s/i.exec(title || "");
  if (!m) return { label: null, breaking: false };
  return { label: TITLE_TYPES[m[1].toLowerCase()] || null, breaking: Boolean(m[2]) };
}

// Labels to add: the linked issues' type labels, the title's type, and
// door:one-way for a one-way door or a breaking ("!") title. oneWay tells the
// caller whether door:one-way should be present at all (it follows the body).
function describeLabels({ title, body, issueLabels = [] }) {
  const add = new Set(issueLabels.filter((l) => TYPE_LABELS.includes(l)));
  const t = titleType(title);
  if (t.label) add.add(t.label);
  const oneWay = mergeDangerDoor(body) === "one-way" || t.breaking;
  if (oneWay) add.add(ONE_WAY_LABEL);
  return { add: [...add], oneWay };
}

// Copilot opens a draft titled "[WIP] ..." and drops the prefix when it finishes.
function isCopilotDone(pr) {
  return /^copilot\//.test(pr.head.ref) && !/^\s*\[WIP\]/i.test(pr.title);
}

// Latest review per user; approvals only count on the current head and from
// someone other than the author.
function humanApprovals(reviews, { headSha, author }) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || r.user.type !== "User") continue;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r);
  }
  const approvers = [];
  const blockers = [];
  for (const [login, r] of latest) {
    if (r.state === "CHANGES_REQUESTED") blockers.push(login);
    if (r.state === "APPROVED" && r.commit_id === headSha && login !== author) approvers.push(login);
  }
  return { approvers, blockers };
}

// Is the cloud agent working on the PR? The last copilot_work_started /
// copilot_work_finished timeline event decides. A fix request posted after the
// last finish counts as work about to start, until it is staleMs old.
function copilotBusy(timeline, { requestedAt = [], now = Date.now(), staleMs = 30 * 60 * 1000 } = {}) {
  let started = 0;
  let finished = 0;
  for (const e of timeline) {
    const t = Date.parse(e.created_at);
    if (e.event === "copilot_work_started") started = Math.max(started, t);
    if (e.event === "copilot_work_finished") finished = Math.max(finished, t);
  }
  if (started > finished) return true;
  return requestedAt.map(Date.parse).some((t) => t > finished && now - t < staleMs);
}

const isCopilotReviewerLogin = (login) => /^copilot-pull-request-reviewer(\[bot\])?$/.test(login || "");

// Unresolved review threads that block a merge. A Copilot thread whose code has
// since changed (outdated) no longer blocks: the review of the new head
// re-raises it if it still applies. Human threads block until resolved.
// threads: [{ isResolved, isOutdated, author }]
function blockingThreads(threads) {
  return threads.filter((t) => !t.isResolved && !(t.isOutdated && isCopilotReviewerLogin(t.author)));
}

// Hidden marker the dispatcher puts in its fix-request comments.
const FIX_REQUEST_RE = /<!-- factory:fix-request sha=([0-9a-f]{40}) round=(\d+) -->/;
function parseFixRequest(body) {
  const m = FIX_REQUEST_RE.exec(body || "");
  return m ? { sha: m[1], round: Number(m[2]) } : null;
}

// Review fix loop: ask @copilot to address Copilot's review of the current head,
// at most maxRounds times per PR, then hand the PR to a human. A request on
// this head that ended (agent finished or the request went stale) without a
// new commit means Copilot declined or failed: a human takes over.
function fixLoopAction({ reviewedHead, copilotThreads, busy, requestedForHead, rounds, maxRounds = 2 }) {
  if (!reviewedHead || copilotThreads === 0 || busy) return "none";
  if (requestedForHead || rounds >= maxRounds) return "escalate";
  return "request";
}

module.exports = {
  LIMITS,
  SENSITIVE,
  HOLD_LABELS,
  mergeDangerDoor,
  TYPE_LABELS,
  ONE_WAY_LABEL,
  titleType,
  describeLabels,
  copilotBusy,
  isCopilotReviewerLogin,
  blockingThreads,
  parseFixRequest,
  fixLoopAction,
  isLocalSpecBranch,
  specBranch,
  isSpecBranch, classifyRisk, closingRefs, isCopilotDone, humanApprovals };

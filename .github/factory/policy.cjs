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

// plan adds TICKETS_READY to the spec after its last ticket exists, so no
// ticket of a spec is built before the whole breakdown (and its blocked-by
// edges) is in place.
const TICKETS_READY = "tickets:ready";

// Why a ready-for-agent issue must wait (null: it may be assigned). A spec is
// never built itself; a ticket of a spec waits for approval and for plan to
// finish. Issues outside a spec keep the direct ready-for-agent path.
function ticketGate(issueLabels, parent) {
  const isSpec = (labels) => labels.includes("spec") || labels.includes("spec:approved");
  if (isSpec(issueLabels)) return "spec";
  if (!parent || !isSpec(parent.labels)) return null;
  if (!parent.labels.includes("spec:approved")) return "spec-not-approved";
  if (!parent.labels.includes(TICKETS_READY) || parent.planning) return "tickets-pending";
  return null;
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
function isCopilotUnfinished(pr) {
  return /^copilot\//.test(pr.head.ref) && /^\s*\[WIP\]/i.test(pr.title || "");
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

const MINUTE = 60 * 1000;
// When the cloud agent counts as stuck. Sessions normally last minutes; the
// agent's own session limit is about an hour.
const AGENT_LIMITS = { noPrMs: 30 * MINUTE, sessionMs: 90 * MINUTE, wipMs: 15 * MINUTE };

// The agent's sessions on a PR, from its timeline: the last start, the last
// finish (any copilot_work_finished* event) and whether that finish failed.
// Copilot code review posts copilot_work_started too (from its own app) and
// never a finish, so only the coding agent's events count.
const AGENT_APP = "copilot-swe-agent";
function agentSession(timeline) {
  let started = 0;
  let finished = 0;
  let failed = false;
  for (const e of timeline) {
    const app = e.performed_via_github_app?.slug;
    if (app && app !== AGENT_APP) continue;
    const t = Date.parse(e.created_at);
    if (e.event === "copilot_work_started") started = Math.max(started, t);
    if (/^copilot_work_finished/.test(e.event || "") && t >= finished) {
      finished = t;
      failed = /fail|error/i.test(e.event);
    }
  }
  return { started, finished, failed, running: started > finished };
}

// Is the cloud agent working on the PR? The last copilot_work_started /
// copilot_work_finished timeline event decides, but a session that never
// finished stops counting after maxSessionMs (the agent died). A fix request
// posted after the last finish counts as work about to start, until it is
// staleMs old.
function copilotBusy(
  timeline,
  { requestedAt = [], now = Date.now(), staleMs = 30 * MINUTE, maxSessionMs = 2 * AGENT_LIMITS.sessionMs } = {},
) {
  const { started, finished, running } = agentSession(timeline);
  if (running) return now - started < maxSessionMs;
  return requestedAt.map(Date.parse).some((t) => t > finished && now - t < staleMs);
}

// Health of a ticket the cloud agent was given. `since` is the later of the
// assignment and the last automatic retry; pr is the agent's open PR
// ({ title, draft, timeline }) and closedPr its last unmerged, closed one.
// Returns { status: ok | stalled | failed | closed | unassigned, reason }.
function agentHealth({ assigned = true, since = 0, pr = null, closedPr = null, now = Date.now(), limits = AGENT_LIMITS }) {
  const mins = (ms) => Math.round(ms / MINUTE);
  const ok = { status: "ok", reason: "" };
  if (!pr) {
    if (closedPr) return { status: "closed", reason: `its pull request #${closedPr.number} was closed without merging` };
    if (!assigned) return { status: "unassigned", reason: "the Copilot cloud agent is no longer assigned" };
    if (now - since > limits.noPrMs) return { status: "stalled", reason: `the agent opened no pull request within ${mins(limits.noPrMs)} minutes` };
    return ok;
  }
  const s = agentSession(pr.timeline || []);
  if (s.running) {
    return now - s.started > limits.sessionMs
      ? { status: "stalled", reason: `the agent's session has run for over ${mins(limits.sessionMs)} minutes without finishing` }
      : ok;
  }
  // A retry was asked for after the last session: give the agent time to start.
  if (since > s.finished) {
    return now - since > limits.noPrMs
      ? { status: "stalled", reason: `the agent did not pick the work up again within ${mins(limits.noPrMs)} minutes` }
      : ok;
  }
  if (s.failed) return { status: "failed", reason: "the agent's session ended with an error" };
  // Draft or not: a session can die after marking the PR ready but before
  // its wrap-up (title and description).
  if (/^\s*\[WIP\]/i.test(pr.title || "") && s.finished && now - s.finished > limits.wipMs) {
    return { status: "stalled", reason: `the agent's session ended but the pull request is still ${pr.draft ? "a [WIP] draft" : "titled [WIP]"}` };
  }
  return ok;
}

// What the dispatcher does about an unhealthy ticket: retry up to maxRetries
// times, except when a human closed the PR or unassigned the agent.
function recoveryAction({ status }, { retries, maxRetries = 1 }) {
  if (status === "ok") return "none";
  if (status === "closed" || status === "unassigned") return "handoff";
  return retries < maxRetries ? "retry" : "handoff";
}

const AGENT_RETRY_MARKER = "<!-- factory:agent-retry -->";

// A failed CI run looks like infrastructure, not code, when the run never
// started properly or timed out, or when a job failed without any failed step
// (a lost runner, a cancelled job).
function isInfraFailure(run, jobs = []) {
  if (["startup_failure", "timed_out"].includes(run.conclusion)) return true;
  if (run.conclusion !== "failure") return false;
  const bad = jobs.filter((j) => ["failure", "timed_out", "cancelled"].includes(j.conclusion));
  return bad.length > 0 && bad.every((j) => j.conclusion !== "failure" || !(j.steps || []).some((s) => s.conclusion === "failure"));
}

// Labels any of which mean triage ran (or a human already decided).
const TRIAGED_LABELS = ["bug", "enhancement", "documentation", "needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix", "spec", "spec:approved", "factory:failure", "architecture"];

// Should the sweep re-run triage on this issue? labels: names; createdAt and
// triageLabelledAt: ISO strings (the latter when `triage` is on the issue).
// Returns "none" | "retry" | "giveup".
function triageRetry({ labels, createdAt, triageLabelledAt = null, retries, now = Date.now(), graceMs = 60 * MINUTE, maxRetries = 1 }) {
  if (labels.some((l) => TRIAGED_LABELS.includes(l))) return "none";
  const since = Date.parse(triageLabelledAt || createdAt);
  if (now - since < graceMs) return "none";
  return retries < maxRetries ? "retry" : "giveup";
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

// Stage of an open issue from its labels. The cockpit groups its queue by it
// and the project board's Status follows it, so both always agree.
function issueStage(labels) {
  const has = (n) => labels.includes(n);
  if (has("agent:failed") || has("factory:failure")) return "attention";
  if (has("status:in-progress")) return "in-progress";
  if (has("ready-for-agent")) return "ready";
  if (has("spec:approved")) return "approved";
  if (has("spec")) return "spec";
  if (has("needs-info")) return "needs-info";
  if (has("ready-for-human")) return "human";
  if (has("wontfix")) return "wontfix";
  return "triage";
}

// Single-select fields of the project board. Status replaces the default
// Todo / In Progress / Done so the board view, which groups by Status, shows
// the factory's stages. scripts/setup-repo.sh creates them from this list.
const PROJECT_FIELDS = {
  Status: [
    ["Needs attention", "RED", "A run or the agent failed twice: see the cockpit"],
    ["Triage", "PURPLE", "New: triage comments, a maintainer decides"],
    ["Needs info", "ORANGE", "Waiting for the reporter"],
    ["Spec", "BLUE", "Spec written on the issue: review and approve it"],
    ["Spec approved", "GREEN", "Split into tickets, being built"],
    ["Ready for agent", "BLUE", "Waiting for a free agent slot or a blocker"],
    ["In progress", "YELLOW", "The cloud agent or a person is on it"],
    ["In review", "PINK", "Pull request open: checks and Copilot review"],
    ["Needs human", "ORANGE", "High risk or handed back: a person decides"],
    ["Done", "GREEN", "Merged or closed as completed"],
    ["Won't fix", "GRAY", "Closed without a change"],
  ],
  Kind: [
    ["Spec", "BLUE", "An issue carrying a spec"],
    ["Ticket", "PURPLE", "A sub-issue of a spec"],
    ["Bug", "RED", ""],
    ["Enhancement", "GREEN", ""],
    ["Pull request", "GRAY", ""],
    ["Report", "ORANGE", "A gh-aw failure report"],
    ["Other", "GRAY", "Not triaged yet"],
  ],
  Risk: [
    ["Low", "GREEN", "Merges automatically when checks and review pass"],
    ["High", "RED", "Needs a human approval"],
  ],
};

const STAGE_STATUS = {
  attention: "Needs attention",
  triage: "Triage",
  "needs-info": "Needs info",
  spec: "Spec",
  approved: "Spec approved",
  ready: "Ready for agent",
  "in-progress": "In progress",
  human: "Needs human",
  wontfix: "Won't fix",
};

// Project field values for an issue or pull request, as returned by the
// REST issues API (pull requests carry `pull_request` there). null clears.
function projectValues(item) {
  const labels = (item.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  const has = (n) => labels.includes(n);
  if (item.pull_request) {
    let status;
    if (item.pull_request.merged_at) status = "Done";
    else if (item.state === "closed") status = "Won't fix";
    else if (item.draft || /^\[WIP\]/i.test(item.title || "")) status = "In progress";
    else if (has("needs-human") || has("hold") || (has("risk:high") && !has("human-approved"))) status = "Needs human";
    else status = "In review";
    return { Status: status, Kind: "Pull request", Risk: has("risk:high") ? "High" : has("risk:low") ? "Low" : null };
  }
  let kind = "Other";
  if (/^\[aw\]/.test(item.title || "")) kind = "Report";
  else if (has("spec") || has("spec:approved") || item.sub_issues_summary?.total > 0) kind = "Spec";
  else if (item.parent_issue_url) kind = "Ticket";
  else if (has("bug")) kind = "Bug";
  else if (has("enhancement")) kind = "Enhancement";
  let status;
  if (item.state === "closed") status = item.state_reason === "not_planned" || item.state_reason === "duplicate" || has("wontfix") ? "Won't fix" : "Done";
  else status = STAGE_STATUS[issueStage(labels)];
  return { Status: status, Kind: kind, Risk: null };
}

// Tests-bite: a change to source code must come with a test that fails on the
// base branch and passes on the pull request, so a test that cannot catch the
// bug (or the missing feature) does not count. Types that need no new test
// (docs, refactor, test, ci, build) skip the check; so do changes that touch
// no source code.
const TEST_FILE = /(^|\/)(tests?|__tests__|src\/test)\/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.(java|kt|cs)$/;
const NON_SOURCE = /^(\.github|\.devcontainer|docs|samples)\/|\.(md|txt|png|jpe?g|svg|gif)$|^(LICENSE|CODEOWNERS|\.gitignore)$/;
const BITE_SKIP_TYPES = ["documentation", "refactor", "tests", "ci", "dependencies"];

function isTestFile(path) {
  return TEST_FILE.test(path || "");
}

// What the tests-bite check does for a pull request: "skip", "fail" (source
// changed, no test changed) or "run" the changed tests against base and head.
function biteMode({ title, files = [], headRef = "" }) {
  if (isSpecBranch(headRef)) return { mode: "skip", reason: "integration pull request (each ticket was checked)", tests: [] };
  const type = titleType(title).label;
  if (BITE_SKIP_TYPES.includes(type)) return { mode: "skip", reason: `${type} change`, tests: [] };
  const tests = files.filter(isTestFile);
  const source = files.filter((f) => !isTestFile(f) && !NON_SOURCE.test(f));
  if (!source.length) return { mode: "skip", reason: "no source code changed", tests };
  if (!tests.length) return { mode: "fail", reason: "source code changed but no test was added or changed", tests };
  return { mode: "run", reason: `${tests.length} changed test file(s)`, tests };
}

// The verdict after running each changed test file on base and on head.
// results: [{ file, base: exitCode, head: exitCode }]
function biteVerdict(results) {
  const notPassing = results.filter((r) => r.head !== 0).map((r) => r.file);
  if (notPassing.length) return { ok: false, reason: `failing on the pull request: ${notPassing.join(", ")}` };
  if (!results.some((r) => r.base !== 0)) {
    return { ok: false, reason: "every changed test also passes on the base branch, so none of them checks this change" };
  }
  return { ok: true, reason: `bites: ${results.filter((r) => r.base !== 0).map((r) => r.file).join(", ")}` };
}

// CI evidence (evidence.yml + evidence-publish.yml): screenshots of the base
// branch ("before") and the pull request ("after") come from an untrusted run,
// so the publisher accepts only these file names.
const EVIDENCE_SHOT = /^(before|after)-[a-z0-9]+(?:-[a-z0-9]+){0,6}\.png$/;
const EVIDENCE_MARKER = "<!-- factory:evidence -->";

function isEvidenceShot(name) {
  return typeof name === "string" && name.length <= 80 && EVIDENCE_SHOT.test(name);
}

// The pull request comment: one row per shot (viewport, scheme, page), before
// and after side by side. url(name) gives an image's address.
function evidenceComment({ names, url, sha, runUrl }) {
  const rows = new Map();
  for (const name of names.filter(isEvidenceShot).sort()) {
    const [, side, key] = /^(before|after)-(.+)\.png$/.exec(name);
    rows.set(key, { ...rows.get(key), [side]: name });
  }
  const cell = (name) => (name ? `<img src="${url(name)}" width="360">` : "_none_");
  const lines = [
    EVIDENCE_MARKER,
    `### Screenshots from CI (${sha.slice(0, 7)})`,
    "",
    "Taken by the Evidence workflow from the base branch and from this pull request, with synthetic data. The agent did not make them.",
    "",
    "| Shot | Before (base) | After (this PR) |",
    "|---|---|---|",
    ...[...rows].map(([key, r]) => `| \`${key}\` | ${cell(r.before)} | ${cell(r.after)} |`),
  ];
  if (runUrl) lines.push("", `[Evidence run](${runUrl})`);
  return lines.join("\n");
}

// Alerts (alerts.yml): items carrying one of these labels wait for a human.
// Each label is announced once per time it is added; the alert comment
// records which labels it covered.
const ATTENTION_LABELS = ["agent:failed", "factory:failure", "needs-human"];
const ALERT_MARKER = /<!-- factory:alert labels=([a-z0-9:,_-]*) -->/;
const alertMarker = (labels) => `<!-- factory:alert labels=${labels.join(",")} -->`;

// labels: names on the item; labeledAt: { label: ISO time it was last added };
// alerts: [{ body, created_at }] written by the alerts workflow (comments, or
// the body of an issue it opened). A label added within a minute after an
// alert that covers it counts as covered (an issue created with its label).
function alertDue({ labels, labeledAt = {}, alerts = [] }) {
  return labels.filter((label) => {
    if (!ATTENTION_LABELS.includes(label)) return false;
    const covered = alerts
      .filter((a) => (ALERT_MARKER.exec(a.body || "")?.[1] || "").split(",").includes(label))
      .reduce((t, a) => Math.max(t, Date.parse(a.created_at)), 0);
    if (!covered) return true;
    return Date.parse(labeledAt[label] || 0) > covered + 60 * 1000;
  });
}

// "@a, b, @org/team" -> "@a @b @org/team"
const mentions = (owners) =>
  (owners || "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((o) => (o.startsWith("@") ? o : `@${o}`))
    .join(" ");

module.exports = {
  issueStage,
  PROJECT_FIELDS,
  projectValues,
  LIMITS,
  SENSITIVE,
  HOLD_LABELS,
  mergeDangerDoor,
  TYPE_LABELS,
  ONE_WAY_LABEL,
  titleType,
  describeLabels,
  copilotBusy,
  AGENT_LIMITS,
  AGENT_RETRY_MARKER,
  agentSession,
  agentHealth,
  recoveryAction,
  isInfraFailure,
  TRIAGED_LABELS,
  triageRetry,
  isCopilotReviewerLogin,
  blockingThreads,
  parseFixRequest,
  fixLoopAction,
  isLocalSpecBranch,
  specBranch,
  TICKETS_READY,
  ticketGate,
  ATTENTION_LABELS,
  alertMarker,
  alertDue,
  mentions,
  isTestFile,
  biteMode,
  biteVerdict,
  EVIDENCE_MARKER,
  isEvidenceShot,
  evidenceComment,
  isSpecBranch, classifyRisk, closingRefs, isCopilotDone, isCopilotUnfinished, humanApprovals };

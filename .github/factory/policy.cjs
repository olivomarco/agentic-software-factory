// Pure rules shared by dispatch.cjs and risk-gate.cjs. No GitHub calls here,
// so the policy can be unit tested (policy.test.cjs) and reviewed on its own.

const LIMITS = { maxLines: 300, maxFiles: 12 };

// Paths whose changes always need a human, whatever their size.
const SENSITIVE = [
  /^\.github\//,
  /^package(-lock)?\.json$/,
  /^AGENTS\.md$/,
  /^CODING_STANDARDS\.md$/,
  /^docs\/adr\//,
];

const SPEC_BRANCH_PREFIX = "factory/spec-";

function specBranch(specNumber) {
  return `${SPEC_BRANCH_PREFIX}${specNumber}`;
}

function isSpecBranch(ref) {
  return typeof ref === "string" && ref.startsWith(SPEC_BRANCH_PREFIX);
}

// files: [{ filename, previous_filename?, additions, deletions }], labels: [string]
function classifyRisk({ files, labels = [], limits = LIMITS }) {
  const reasons = [];
  const lines = files.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  if (lines > limits.maxLines) reasons.push(`${lines} changed lines (limit ${limits.maxLines})`);
  if (files.length > limits.maxFiles) reasons.push(`${files.length} files (limit ${limits.maxFiles})`);
  const paths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const sensitive = [...new Set(paths.filter((p) => SENSITIVE.some((re) => re.test(p))))];
  if (sensitive.length) reasons.push(`sensitive paths: ${sensitive.join(", ")}`);
  if (labels.includes("hold")) reasons.push("`hold` label");
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

module.exports = { LIMITS, SENSITIVE, specBranch, isSpecBranch, classifyRisk, closingRefs, isCopilotDone, humanApprovals };

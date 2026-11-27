// Reads and changes the factory's state through the `gh` CLI, so the cockpit
// acts with the signed-in user's own identity and permissions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function gh(args, { cwd } = {}) {
  const { stdout } = await run("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  return stdout;
}

const ghJson = async (args, opts) => JSON.parse((await gh(args, opts)) || "null");

// Open tickets of a spec the cloud agent is still working on. A spec cannot
// switch to the local lane while any exist: their PRs would land on
// factory/spec-N after the local branch was cut from it.
export async function cloudTicketsInFlight(repo, number) {
  const pages = await ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/sub_issues?per_page=100`]);
  return pages
    .flat()
    .filter((t) => t.state === "open")
    .filter((t) => t.labels?.some((l) => l.name === "status:in-progress") || t.assignees?.some((a) => /copilot/i.test(a.login)))
    .map((t) => t.number);
}

export async function detectRepo(cwd) {
  return (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd })).trim();
}

const names = (labels) => labels.map((l) => l.name);

function stage(labels) {
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

// "Risk gate" commit status and check runs of a PR, from statusCheckRollup.
function gateOf(rollup) {
  const out = { gate: null, gateText: "", checks: [] };
  for (const c of rollup || []) {
    if (c.__typename === "StatusContext" && c.context === "factory/risk-gate") {
      out.gate = (c.state || "").toLowerCase();
      out.gateText = c.description || "";
    } else if (c.__typename === "CheckRun") {
      out.checks.push({ name: c.name, state: (c.conclusion || c.status || "").toLowerCase() });
    }
  }
  return out;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

// Failed workflow runs of the last day that nothing has fixed since: only the
// latest run per workflow and title counts (a later success or a successful
// re-run clears it). Dynamic runs (the cloud agent, Copilot code review)
// cannot be re-run from here.
async function failedRuns(repo) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19);
  const { workflow_runs: runs = [] } = await ghJson(["api", `repos/${repo}/actions/runs?per_page=100&created=>=${since}`]);
  const latest = new Map();
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const key = `${r.workflow_id}:${r.display_title}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  return [...latest.values()]
    .filter((r) => FAILED.has(r.conclusion))
    .map((r) => ({
      id: r.id,
      workflow: r.name,
      title: r.display_title,
      event: r.event,
      conclusion: r.conclusion,
      attempt: r.run_attempt,
      url: r.html_url,
      at: r.updated_at,
      rerunnable: !String(r.path || "").startsWith("dynamic/"),
    }));
}

export async function loadState(repo) {
  const [issues, prs, projectUrl, runs] = await Promise.all([
    ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues?state=open&per_page=100`]),
    ghJson([
      "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json",
      "number,title,url,labels,baseRefName,headRefName,isDraft,author,reviewDecision,statusCheckRollup,additions,deletions,changedFiles",
    ]),
    gh(["variable", "get", "FACTORY_PROJECT_URL", "--repo", repo]).then((s) => s.trim()).catch(() => ""),
    failedRuns(repo).catch(() => []),
  ]);

  const openIssues = issues.flat().filter((i) => !i.pull_request).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    labels: names(i.labels),
    stage: stage(names(i.labels)),
    assignees: i.assignees.map((a) => a.login),
    blockedBy: i.issue_dependencies_summary?.blocked_by ?? 0,
    subIssues: i.sub_issues_summary?.total ?? 0,
    comments: i.comments,
    updated: i.updated_at,
  }));

  const specs = [];
  for (const spec of openIssues.filter((i) => i.subIssues > 0 || i.stage === "spec" || i.stage === "approved")) {
    const subs = spec.subIssues
      ? await ghJson(["api", "--paginate", "--slurp", `repos/${repo}/issues/${spec.number}/sub_issues?per_page=100`])
      : [];
    specs.push({
      ...spec,
      branch: `factory/spec-${spec.number}`,
      tickets: subs.flat().map((t) => ({
        number: t.number,
        title: t.title,
        url: t.html_url,
        state: t.state,
        labels: names(t.labels),
        blockedBy: t.issue_dependencies_summary?.blocked_by ?? 0,
      })),
    });
  }

  const pulls = prs.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    labels: names(p.labels),
    base: p.baseRefName,
    head: p.headRefName,
    draft: p.isDraft,
    author: p.author?.login,
    review: p.reviewDecision,
    size: { additions: p.additions, deletions: p.deletions, files: p.changedFiles },
    risk: names(p.labels).find((l) => l.startsWith("risk:"))?.slice(5) ?? null,
    ...gateOf(p.statusCheckRollup),
  }));

  return { repo, projectUrl, fetchedAt: new Date().toISOString(), issues: openIssues, specs, pulls, failedRuns: runs };
}

// The only changes the cockpit makes: each one maps to a factory primitive.
export const ACTIONS = {
  "ready-for-agent": (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--add-label", "ready-for-agent"]),
  "approve-spec": (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--add-label", "spec:approved"]),
  "lane-local": (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--add-label", "lane:local"]),
  retriage: (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--add-label", "triage"]),
  spec: (repo, n) => gh(["issue", "comment", String(n), "--repo", repo, "--body", "/spec"]),
  wontfix: (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--add-label", "wontfix"]),
  "human-approve": (repo, n) => gh(["pr", "edit", String(n), "--repo", repo, "--add-label", "human-approved"]),
  hold: (repo, n) => gh(["pr", "edit", String(n), "--repo", repo, "--add-label", "hold"]),
  unhold: (repo, n) => gh(["pr", "edit", String(n), "--repo", repo, "--remove-label", "hold"]),
  // Failure recovery. retry-agent restarts the agent with a fresh retry budget.
  "retry-agent": (repo, n) =>
    gh(["issue", "edit", String(n), "--repo", repo, "--remove-label", "agent:failed,ready-for-human", "--add-label", "ready-for-agent"]),
  "retriage-failed": (repo, n) => gh(["issue", "edit", String(n), "--repo", repo, "--remove-label", "factory:failure", "--add-label", "triage"]),
  "close-report": (repo, n) => gh(["issue", "close", String(n), "--repo", repo, "--comment", "Handled from the factory cockpit."]),
  // A run that never started has no failed jobs to re-run: re-run all of it.
  "rerun-run": (repo, id) =>
    gh(["run", "rerun", String(id), "--failed", "--repo", repo]).catch(() => gh(["run", "rerun", String(id), "--repo", repo])),
  "gate-pr": (repo, n) => gh(["workflow", "run", "risk-gate.yml", "--repo", repo, "-f", `pr=${n}`]),
  dispatch: (repo) => gh(["workflow", "run", "dispatch.yml", "--repo", repo]),
};

// Deterministic dispatcher (run by dispatch.yml through actions/github-script,
// authenticated with the agent token). Every run is a full, idempotent sweep:
//   1. close tickets whose PR was merged into a spec branch (closing keywords
//      only fire on the default branch);
//   2. assign the Copilot cloud agent to unblocked `ready-for-agent` issues,
//      targeting factory/spec-<parent> when the parent is an approved spec;
//   3. open the integration PR for every approved spec whose tickets are done.
const { specBranch, closingRefs } = require("./policy.cjs");

const COPILOT_LOGINS = ["copilot-swe-agent[bot]", "copilot-swe-agent"];
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const fullName = `${owner}/${repo}`;
  const maxActive = Number(process.env.MAX_ACTIVE || 3);
  const customAgent = process.env.CUSTOM_AGENT || "factory-implementer";
  const runUrl = `${context.serverUrl}/${fullName}/actions/runs/${context.runId}`;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.default_branch;

  const has = (issue, name) => issue.labels.some((l) => (l.name || l) === name);
  const comment = (issue_number, body) => github.rest.issues.createComment({ owner, repo, issue_number, body });
  const removeLabel = (issue_number, name) =>
    github.rest.issues.removeLabel({ owner, repo, issue_number, name }).catch((e) => {
      if (e.status !== 404) throw e;
    });
  const notFound = (e) => {
    if (e.status === 404) return null;
    throw e;
  };

  async function canWrite(login) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }).catch(() => ({ data: {} }));
    return WRITE_ROLES.has(data.role_name) || WRITE_ROLES.has(data.permission);
  }

  // Who added the label last? A maintainer, or this repo's own workflows (plan).
  async function labelledByTrustedActor(issue_number, label) {
    const events = await github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number, per_page: 100 });
    const last = events.filter((e) => e.event === "labeled" && e.label?.name === label).pop();
    if (!last?.actor) return { ok: false, who: "unknown" };
    if (last.actor.login === "github-actions[bot]") return { ok: true, who: last.actor.login };
    return { ok: await canWrite(last.actor.login), who: last.actor.login };
  }

  async function ensureBranch(branch) {
    const existing = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }).catch(notFound);
    if (existing) return;
    const { data: base } = await github.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: base.object.sha });
    core.info(`Created ${branch} from ${defaultBranch}`);
  }

  const parentOf = (issue_number) =>
    github
      .request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", { owner, repo, issue_number })
      .then((r) => r.data)
      .catch(notFound);

  const openIssues = async () =>
    (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", per_page: 100 })).filter((i) => !i.pull_request);

  const subIssues = (issue_number) =>
    github.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { owner, repo, issue_number, per_page: 100 });

  // 1. Tickets merged into a spec branch. Start from the agent's own open
  // tickets (no time window to fall out of) and accept only a merged PR from a
  // copilot/* branch of this repository into the ticket's own spec branch.
  // Only writers can assign, so a Copilot-named assignee is the cloud agent.
  const isCopilot = (u) => /copilot/i.test(u?.login || "");
  let open = await openIssues();
  for (const issue of open.filter((i) => has(i, "status:in-progress") && i.assignees.some(isCopilot))) {
    const parent = await parentOf(issue.number);
    if (!parent) continue;
    const branch = specBranch(parent.number);
    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: issue.number, per_page: 100 });
    const prNumbers = new Set(
      timeline
        .filter((e) => e.event === "cross-referenced" && e.source?.issue?.pull_request && e.source.issue.repository?.full_name === fullName)
        .map((e) => e.source.issue.number),
    );
    for (const number of prNumbers) {
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
      const ok =
        pr.merged_at &&
        pr.base.ref === branch &&
        /^copilot\//.test(pr.head.ref) &&
        pr.head.repo?.full_name === fullName &&
        closingRefs(pr.body, fullName).includes(issue.number);
      if (!ok) continue;
      await comment(issue.number, `Merged into \`${branch}\` by #${pr.number}; it reaches \`${defaultBranch}\` with the spec's integration pull request.`);
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: "closed", state_reason: "completed" });
      await removeLabel(issue.number, "status:in-progress");
      core.info(`Closed #${issue.number} (merged in #${pr.number})`);
      break;
    }
  }
  open = await openIssues();

  // 2. Assign unblocked tickets, oldest first, up to MAX_ACTIVE at a time.
  let active = open.filter((i) => has(i, "status:in-progress")).length;
  const ready = open.filter((i) => has(i, "ready-for-agent") && !has(i, "status:in-progress")).sort((a, b) => a.number - b.number);
  for (const listed of ready) {
    const n = listed.number;
    if (active >= maxActive) {
      core.info(`${active} tickets in progress (MAX_ACTIVE=${maxActive}); the rest wait for the next run`);
      break;
    }
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: n });
    if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) {
      core.info(`#${n} is blocked by ${issue.issue_dependencies_summary.blocked_by} open issue(s)`);
      continue;
    }
    const approval = await labelledByTrustedActor(n, "ready-for-agent");
    if (!approval.ok) {
      await comment(n, `\`ready-for-agent\` was added by @${approval.who}, who lacks write access, so the factory ignored it. A maintainer has to add it.`);
      await removeLabel(n, "ready-for-agent");
      continue;
    }
    const parent = await parentOf(n);
    const base = parent && parent.labels.some((l) => l.name === "spec:approved") ? specBranch(parent.number) : defaultBranch;
    if (base !== defaultBranch) await ensureBranch(base);

    let assigned = null;
    for (const login of COPILOT_LOGINS) {
      try {
        await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
          owner,
          repo,
          issue_number: n,
          assignees: [login],
          agent_assignment: { base_branch: base, custom_agent: customAgent },
        });
      } catch (e) {
        core.info(`Assigning ${login} failed: ${e.message}`);
        continue;
      }
      const { data: after } = await github.rest.issues.get({ owner, repo, issue_number: n });
      if (after.assignees.some((a) => /copilot/i.test(a.login))) {
        assigned = login;
        break;
      }
    }
    if (!assigned) {
      core.setFailed(
        `Could not assign the Copilot cloud agent to #${n}. Check that the cloud agent is enabled and that GH_AW_AGENT_TOKEN in the copilot-agent environment is a user token (see docs/factory.md).`,
      );
      return;
    }
    await github.rest.issues.addLabels({ owner, repo, issue_number: n, labels: ["status:in-progress"] });
    await removeLabel(n, "ready-for-agent");
    await comment(n, `🚀 Assigned to the Copilot cloud agent (custom agent \`${customAgent}\`, base branch \`${base}\`). [Dispatch run](${runUrl})`);
    active += 1;
    core.info(`Assigned #${n} on ${base}`);
  }

  // 3. Integration PRs for finished specs.
  for (const spec of open.filter((i) => has(i, "spec:approved"))) {
    const tickets = await subIssues(spec.number);
    if (!tickets.length || tickets.some((t) => t.state === "open")) continue;
    const branch = specBranch(spec.number);
    if (!(await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }).catch(notFound))) continue;
    const { data: cmp } = await github.rest.repos.compareCommits({ owner, repo, base: defaultBranch, head: branch });
    if (cmp.ahead_by === 0) continue;
    const { data: prs } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base: defaultBranch, state: "open" });
    if (prs.length) continue;
    const { data: pr } = await github.rest.pulls.create({
      owner,
      repo,
      head: branch,
      base: defaultBranch,
      title: `Spec #${spec.number}: ${spec.title}`,
      body: [
        `Closes #${spec.number}`,
        "",
        `Integrates the tickets of the approved spec #${spec.number}, each already merged into \`${branch}\` through its own pull request:`,
        "",
        ...tickets.map((t) => `- #${t.number} ${t.title}`),
        "",
        "The risk gate decides whether this merges on its own or waits for a human approval.",
      ].join("\n"),
    });
    await comment(spec.number, `All tickets are done. Integration pull request: #${pr.number}`);
    core.info(`Opened integration PR #${pr.number} for spec #${spec.number}`);
  }
};

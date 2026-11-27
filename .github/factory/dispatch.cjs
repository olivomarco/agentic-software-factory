// Deterministic dispatcher (run by dispatch.yml through actions/github-script,
// authenticated with the agent token). Every run is a full, idempotent sweep:
//   1. close tickets whose PR was merged into a spec branch (closing keywords
//      only fire on the default branch);
//   2. assign the Copilot cloud agent to unblocked `ready-for-agent` issues,
//      targeting factory/spec-<parent> when the parent is an approved spec,
//      except tickets of a `lane:local` spec (built by implement-spec locally);
//   3. open the integration PR for every approved spec whose tickets are done;
//   4. review fix loop: ask @copilot to address Copilot code review comments on
//      its PRs, at most MAX_FIX_ROUNDS times, then label the PR `needs-human`.
//      @copilot only answers users with write access, hence the agent token.
// Recovery from failures (infrastructure included):
//   - watchdog (in 1.): a ticket whose agent session failed, stalled or never
//     opened a PR is retried MAX_AGENT_RETRIES times, then handed to a human
//     (`agent:failed` + `ready-for-human`), which frees its slot;
//   - triage that never labelled an issue is re-run once, then the issue gets
//     `factory:failure`; gh-aw's own "[aw] ... failed" issues get it too;
//   - one failing item never stops the sweep: errors are collected and the run
//     fails at the end, listing them.
const {
  specBranch,
  closingRefs,
  isSpecBranch,
  copilotBusy,
  isCopilotReviewerLogin,
  fixLoopAction,
  parseFixRequest,
  AGENT_LIMITS,
  AGENT_RETRY_MARKER,
  agentHealth,
  recoveryAction,
  triageRetry,
} = require("./policy.cjs");

const COPILOT_LOGINS = ["copilot-swe-agent[bot]", "copilot-swe-agent"];
// Cloud agent sessions run as "dynamic" workflow runs under this path; Copilot
// code review uses dynamic/agents/copilot-pull-request-reviewer.
const AGENT_RUN_PATH = "dynamic/copilot-swe-agent/";
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const fullName = `${owner}/${repo}`;
  const maxActive = Number(process.env.MAX_ACTIVE || 3);
  const maxFixRounds = Number(process.env.MAX_FIX_ROUNDS || 2);
  const customAgent = process.env.CUSTOM_AGENT || "factory-implementer";
  const maxAgentRetries = Number(process.env.MAX_AGENT_RETRIES ?? 1);
  const minutes = (name, fallback) => (process.env[name] ? Number(process.env[name]) * 60 * 1000 : fallback);
  const limits = {
    ...AGENT_LIMITS,
    noPrMs: minutes("AGENT_NO_PR_MINUTES", AGENT_LIMITS.noPrMs),
    sessionMs: minutes("AGENT_SESSION_MINUTES", AGENT_LIMITS.sessionMs),
  };
  const runUrl = `${context.serverUrl}/${fullName}/actions/runs/${context.runId}`;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.default_branch;
  const { data: me } = await github.rest.users.getAuthenticated();
  const now = Date.now();

  // One failing item never stops the sweep; the run fails at the end instead.
  const errors = [];
  async function attempt(what, fn) {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
      core.warning(`${what}: ${e.message}`);
      return undefined;
    }
  }

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
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: base.object.sha }).catch((e) => {
      if (e.status !== 422) throw e;
      throw new Error(
        `could not create ${branch} (${e.message}). A ruleset on factory/** probably blocks branch creation: set do_not_enforce_on_create on its required status checks (docs/ruleset-factory.json) and run scripts/setup-repo.sh again.`,
      );
    });
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

  const isCopilot = (u) => /copilot/i.test(u?.login || "");
  const timelineOf = (issue_number) =>
    github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number, per_page: 100 });
  const lastTime = (events) => events.reduce((t, e) => Math.max(t, Date.parse(e.created_at)), 0);

  // The cloud agent's PRs for a ticket: PRs from copilot/* branches of this
  // repository that cross-reference it.
  async function agentPrs(timeline) {
    const numbers = new Set(
      timeline
        .filter((e) => e.event === "cross-referenced" && e.source?.issue?.pull_request && e.source.issue.repository?.full_name === fullName)
        .map((e) => e.source.issue.number),
    );
    const prs = [];
    for (const number of numbers) {
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
      if (/^copilot\//.test(pr.head.ref) && pr.head.repo?.full_name === fullName) prs.push(pr);
    }
    return prs.sort((a, b) => a.number - b.number);
  }

  // Assigns the cloud agent; returns the login that worked, or null.
  async function assignAgent(n, base) {
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
      if (after.assignees.some(isCopilot)) return login;
    }
    return null;
  }
  const baseFor = (parent) => (parent && parent.labels.some((l) => (l.name || l) === "spec:approved") ? specBranch(parent.number) : defaultBranch);
  const unassignAgent = (issue) => {
    const logins = issue.assignees.filter(isCopilot).map((a) => a.login);
    return logins.length ? github.rest.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees: logins }) : null;
  };

  async function cancelAgentRuns(branch) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, branch, status: "in_progress", per_page: 100 });
    for (const run of runs.filter((r) => r.path?.startsWith(AGENT_RUN_PATH))) {
      await github.rest.actions
        .cancelWorkflowRun({ owner, repo, run_id: run.id })
        .then(() => core.info(`cancelled the stuck agent run ${run.id} on ${branch}`))
        .catch((e) => core.warning(`could not cancel agent run ${run.id}: ${e.message}`));
    }
  }

  // A ticket in progress whose agent failed, stalled, or lost its PR: retry
  // (a new session on its PR, or a fresh assignment), then hand to a human.
  // Retries count from the last time a maintainer made it ready-for-agent.
  async function watch(issue, parent, timeline, prs) {
    const n = issue.number;
    const readyAt = lastTime(timeline.filter((e) => e.event === "labeled" && e.label?.name === "ready-for-agent"));
    const markers = timeline.filter(
      (e) => e.event === "commented" && (e.actor || e.user)?.login === me.login && (e.body || "").includes(AGENT_RETRY_MARKER) && Date.parse(e.created_at) > readyAt,
    );
    const assignedAt = lastTime(timeline.filter((e) => e.event === "assigned" && isCopilot(e.assignee)));
    // Only tickets the agent was given: a human may mark their own work in progress.
    if (!assignedAt && !issue.assignees.some(isCopilot)) return;
    const since = Math.max(assignedAt || readyAt, lastTime(markers));
    const open = prs.filter((p) => p.state === "open").pop();
    const closedPr = open ? null : prs.filter((p) => p.state === "closed" && !p.merged_at).pop();
    const pr = open ? { title: open.title, draft: open.draft, timeline: await timelineOf(open.number) } : null;
    const health = agentHealth({ assigned: issue.assignees.some(isCopilot), since, pr, closedPr, now, limits });
    const action = recoveryAction(health, { retries: markers.length, maxRetries: maxAgentRetries });
    if (action === "none") return;
    // A stuck session holds the PR: GitHub queues new @copilot requests behind
    // it. Cancelling it also records the session as finished.
    if (open) await cancelAgentRuns(open.head.ref);

    if (action === "retry") {
      const round = markers.length + 1;
      if (open) {
        await comment(
          open.number,
          `@copilot Your work on #${n} stopped: ${health.reason}. Please continue from the current state of this branch, finish the ticket and run \`npm test\` again.`,
        );
      } else {
        await unassignAgent(issue);
        if (!(await assignAgent(n, baseFor(parent)))) throw new Error(`could not re-assign the cloud agent to #${n}`);
      }
      await comment(
        n,
        [
          `🔁 ${health.reason[0].toUpperCase()}${health.reason.slice(1)}, so the factory ${open ? `asked the agent to continue on #${open.number}` : "assigned the agent again"} (automatic retry ${round} of ${maxAgentRetries}). [Dispatch run](${runUrl})`,
          AGENT_RETRY_MARKER,
        ].join("\n"),
      );
      core.info(`#${n}: retry ${round} (${health.reason})`);
      return;
    }

    await unassignAgent(issue);
    await github.rest.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:failed", "ready-for-human"] });
    await removeLabel(n, "status:in-progress");
    if (open) await github.rest.issues.addLabels({ owner, repo, issue_number: open.number, labels: ["needs-human"] });
    const retried = markers.length ? ` after ${markers.length} automatic ${markers.length === 1 ? "retry" : "retries"}` : "";
    await comment(
      n,
      [
        `🧑‍🔧 The cloud agent could not finish this ticket: ${health.reason}${retried}. It is now waiting for a human${open ? `; pull request #${open.number} stays open as it is` : ""}.`,
        "",
        "To try the agent again, use **Retry** in the factory cockpit (or remove `agent:failed` and `ready-for-human` and add `ready-for-agent`). Tickets blocked by this one wait until it closes.",
        "",
        `[Dispatch run](${runUrl})`,
      ].join("\n"),
    );
    core.info(`#${n}: handed to a human (${health.reason})`);
  }

  // 1. Tickets in progress: close the ones merged into their spec branch
  // (from a copilot/* branch of this repository, closing this ticket), and
  // watch the rest. lane:local tickets belong to a local session.
  let open = await openIssues();
  for (const issue of open.filter((i) => has(i, "status:in-progress"))) {
    await attempt(`#${issue.number}`, async () => {
      const parent = await parentOf(issue.number);
      if (parent && has(parent, "lane:local")) return;
      const timeline = await timelineOf(issue.number);
      const prs = await agentPrs(timeline);
      if (parent) {
        const branch = specBranch(parent.number);
        const merged = prs.find((pr) => pr.merged_at && pr.base.ref === branch && closingRefs(pr.body, fullName).includes(issue.number));
        if (merged) {
          await comment(issue.number, `Merged into \`${branch}\` by #${merged.number}; it reaches \`${defaultBranch}\` with the spec's integration pull request.`);
          await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: "closed", state_reason: "completed" });
          await removeLabel(issue.number, "status:in-progress");
          core.info(`Closed #${issue.number} (merged in #${merged.number})`);
          return;
        }
      }
      await watch(issue, parent, timeline, prs);
    });
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
    const outcome = await attempt(`#${n}`, async () => {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: n });
      if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) {
        core.info(`#${n} is blocked by ${issue.issue_dependencies_summary.blocked_by} open issue(s)`);
        return "skipped";
      }
      const parent = await parentOf(n);
      if (parent?.labels.some((l) => l.name === "lane:local")) {
        core.info(`#${n} belongs to spec #${parent.number}, which is being built locally (lane:local)`);
        return "skipped";
      }
      const approval = await labelledByTrustedActor(n, "ready-for-agent");
      if (!approval.ok) {
        await comment(n, `\`ready-for-agent\` was added by @${approval.who}, who lacks write access, so the factory ignored it. A maintainer has to add it.`);
        await removeLabel(n, "ready-for-agent");
        return "skipped";
      }
      const base = baseFor(parent);
      if (base !== defaultBranch) await ensureBranch(base);
      if (!(await assignAgent(n, base))) {
        throw new Error(
          `could not assign the Copilot cloud agent. Check that the cloud agent is enabled and that GH_AW_AGENT_TOKEN in the copilot-agent environment is a user token (see docs/factory.md).`,
        );
      }
      await github.rest.issues.addLabels({ owner, repo, issue_number: n, labels: ["status:in-progress"] });
      await removeLabel(n, "ready-for-agent");
      await comment(n, `🚀 Assigned to the Copilot cloud agent (custom agent \`${customAgent}\`, base branch \`${base}\`). [Dispatch run](${runUrl})`);
      core.info(`Assigned #${n} on ${base}`);
      return "assigned";
    });
    if (outcome === "assigned") active += 1;
    // An assignment failure is about the token or the agent, not the ticket.
    if (outcome === undefined && errors.at(-1)?.includes("could not assign")) break;
  }

  // 2b. Triage that never ran or never finished (a failed gh-aw run leaves the
  // issue unlabelled): re-run it once by re-adding `triage`, then flag it.
  // gh-aw's own "[aw] ... failed" issues are flagged too, never triaged.
  for (const issue of open) {
    const labels = issue.labels.map((l) => l.name || l);
    if (/^\[aw\]/.test(issue.title) && issue.user?.type === "Bot") {
      if (!labels.includes("factory:failure")) {
        await attempt(`#${issue.number}`, () => github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ["factory:failure"] }));
      }
      continue;
    }
    if (labels.includes("status:in-progress") || triageRetry({ labels, createdAt: issue.created_at, retries: 0, now }) === "none") continue;
    await attempt(`#${issue.number}`, async () => {
      const events = await github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number: issue.number, per_page: 100 });
      const triageLabels = events.filter((e) => e.event === "labeled" && e.label?.name === "triage");
      const decision = triageRetry({
        labels,
        createdAt: issue.created_at,
        triageLabelledAt: labels.includes("triage") ? triageLabels.at(-1)?.created_at : null,
        retries: triageLabels.filter((e) => e.actor?.login === me.login).length,
        now,
      });
      if (decision === "retry") {
        await removeLabel(issue.number, "triage");
        await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ["triage"] });
        core.info(`#${issue.number}: triage never labelled it; re-running triage`);
      } else if (decision === "giveup") {
        await removeLabel(issue.number, "triage");
        await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ["factory:failure"] });
        await comment(
          issue.number,
          `⚠️ Automatic triage did not complete on this issue, even after a retry. Triage it by hand, or use **Re-triage** in the factory cockpit. [Dispatch run](${runUrl})`,
        );
        core.info(`#${issue.number}: triage failed twice; flagged factory:failure`);
      }
    });
  }

  // 3. Integration PRs for finished specs. A lane:local spec ships through the
  // local session's own local/spec-N pull request instead.
  for (const spec of open.filter((i) => has(i, "spec:approved") && !has(i, "lane:local"))) {
    await attempt(`spec #${spec.number}`, () => integrate(spec));
  }
  async function integrate(spec) {
    const tickets = await subIssues(spec.number);
    if (!tickets.length || tickets.some((t) => t.state === "open")) return;
    const branch = specBranch(spec.number);
    if (!(await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }).catch(notFound))) return;
    const { data: cmp } = await github.rest.repos.compareCommits({ owner, repo, base: defaultBranch, head: branch });
    if (cmp.ahead_by === 0) return;
    const { data: prs } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base: defaultBranch, state: "open" });
    if (prs.length) return;
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

  // 4. Review fix loop on the cloud agent's open, finished PRs. Only this
  // token's own marker comments count, so nobody else can spend or block rounds.
  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
  for (const pr of prs) await attempt(`PR #${pr.number}`, () => fixLoop(pr));
  async function fixLoop(pr) {
    const labels = pr.labels.map((l) => l.name);
    const managedBase = pr.base.ref === defaultBranch || isSpecBranch(pr.base.ref);
    if (pr.draft || !/^copilot\//.test(pr.head.ref) || pr.head.repo?.full_name !== fullName || !managedBase) return;
    if (labels.includes("needs-human") || labels.includes("hold")) return;

    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
    const reviewedHead = reviews.some((r) => r.user?.type === "Bot" && isCopilotReviewerLogin(r.user.login) && r.commit_id === pr.head.sha);
    const q = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login}}}}}}}}`;
    const threads = (await github.graphql(q, { owner, repo, number: pr.number })).repository.pullRequest.reviewThreads.nodes;
    const copilotThreads = threads.filter(
      (t) => !t.isResolved && !t.isOutdated && isCopilotReviewerLogin(t.comments.nodes[0]?.author?.login),
    ).length;
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
    const requests = comments
      .filter((c) => c.user?.login === me.login)
      .map((c) => ({ ...parseFixRequest(c.body), at: c.created_at }))
      .filter((r) => r.sha);
    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: pr.number, per_page: 100 });
    const busy = copilotBusy(timeline, { requestedAt: requests.map((r) => r.at) });
    const requestedForHead = requests.some((r) => r.sha === pr.head.sha);

    const action = fixLoopAction({ reviewedHead, copilotThreads, busy, requestedForHead, rounds: requests.length, maxRounds: maxFixRounds });
    if (action === "request") {
      const round = requests.length + 1;
      await comment(
        pr.number,
        [
          `@copilot Please address the ${copilotThreads} unresolved Copilot code review comment(s) on this pull request.`,
          "Fix the valid ones, reply on each one you decline with the reason, keep the description's Evidence and Merge Danger current, and run `npm test` again.",
          "",
          `_Review fix round ${round} of ${maxFixRounds}. [Dispatch run](${runUrl})_`,
          `<!-- factory:fix-request sha=${pr.head.sha} round=${round} -->`,
        ].join("\n"),
      );
      core.info(`#${pr.number}: asked Copilot to address ${copilotThreads} review comment(s), round ${round}`);
    } else if (action === "escalate") {
      await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ["needs-human"] });
      await comment(
        pr.number,
        `🧑‍⚖️ Copilot code review still has ${copilotThreads} open comment(s) after ${requests.length} fix round(s) (or Copilot left them unchanged), so this pull request now needs a human: resolve or answer the threads, then approve. [Dispatch run](${runUrl})`,
      );
      core.info(`#${pr.number}: escalated to a human after ${requests.length} fix round(s)`);
    }
  }

  if (errors.length) core.setFailed(`${errors.length} item(s) failed; the rest of the sweep completed:\n- ${errors.join("\n- ")}`);
};

// Risk gate (run by risk-gate.yml through actions/github-script with
// GITHUB_TOKEN). For each pull request it evaluates, it:
//   - marks Copilot's draft ready once Copilot has finished;
//   - records a `human-approved` label as an approval of the current head only;
//   - classifies the change (policy.cjs) and sets `risk:low` / `risk:high`;
//   - publishes the commit status `factory/risk-gate`: success when the risk
//     is low or a human approved the current head, pending otherwise;
//   - keeps one comment on high-risk PRs that need a human: the reasons and an
//     "Open in Codespace" link to try the change;
//   - re-runs the failed jobs of a CI run once when the failure looks like
//     infrastructure (startup failure, timeout, a job lost without a failing
//     step), not code;
//   - asks Copilot to review the current head when it has not, and merges
//     when the gate, the required checks and that review all pass, the cloud
//     agent is not working on the PR and no review thread blocks, then wakes
//     the dispatcher (which also runs the review fix loop).
const {
  classifyRisk,
  isCopilotDone,
  isCopilotUnfinished,
  humanApprovals,
  isSpecBranch,
  isLocalSpecBranch,
  mergeDangerDoor,
  closingRefs,
  TYPE_LABELS,
  ONE_WAY_LABEL,
  describeLabels,
  titleType,
  copilotBusy,
  isCopilotReviewerLogin,
  blockingThreads,
  parseFixRequest,
  isInfraFailure,
} = require("./policy.cjs");

const CONTEXT = "factory/risk-gate";
// Records a `human-approved` label against the exact head it was added on.
const APPROVAL_CONTEXT = "factory/human-approval";
const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";
const isCopilotReview = (r) => r.user?.type === "Bot" && r.user.login === COPILOT_REVIEWER;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);
const STICKY = "<!-- factory:risk-gate -->";

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const requiredChecks = (process.env.REQUIRED_CHECKS || "test,tests-bite").split(",").map((s) => s.trim()).filter(Boolean);
  const requireCopilotReview = process.env.REQUIRE_COPILOT_REVIEW !== "false";
  const autoMergeDefault = process.env.AUTO_MERGE_DEFAULT_BRANCH !== "false";
  const autoMergeIntegration = process.env.AUTO_MERGE_INTEGRATION === "true";
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });

  const writeCache = new Map();
  async function canWrite(login) {
    if (!writeCache.has(login)) writeCache.set(login, canWriteUncached(login));
    return writeCache.get(login);
  }
  async function canWriteUncached(login) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }).catch(() => ({ data: {} }));
    return WRITE_ROLES.has(data.role_name) || WRITE_ROLES.has(data.permission);
  }

  async function prNumbers() {
    const p = context.payload;
    if (p.pull_request) return [p.pull_request.number];
    if (process.env.PR_NUMBER) return [Number(process.env.PR_NUMBER)];
    if (p.workflow_run) {
      if (p.workflow_run.pull_requests?.length) return p.workflow_run.pull_requests.map((x) => x.number);
      const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
      return open.filter((x) => x.head.sha === p.workflow_run.head_sha).map((x) => x.number);
    }
    const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
    return open.map((x) => x.number);
  }

  // A writer adding `human-approved` approves the head the PR had at that
  // moment: the label event records it as a commit status on that SHA. The
  // label alone never approves anything, so a later push needs a new label.
  async function recordLabelApproval(number) {
    const p = context.payload;
    if (p.action !== "labeled" || p.label?.name !== "human-approved" || p.pull_request?.number !== number) return;
    const who = p.sender;
    if (who?.type !== "User" || !(await canWrite(who.login))) return;
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: p.pull_request.head.sha,
      state: "success",
      context: APPROVAL_CONTEXT,
      description: `Approved by ${who.login}`.slice(0, 140),
      target_url: runUrl,
    });
  }

  async function labelApprover(pr) {
    if (!pr.labels.some((l) => l.name === "human-approved")) return null;
    const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
    const approval = statuses.find(
      (s) => s.context === APPROVAL_CONTEXT && s.state === "success" && s.creator?.login === "github-actions[bot]",
    );
    if (approval) return approval.description.replace(/^Approved by /, "");
    await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: "human-approved" }).catch(() => {});
    pr.labels = pr.labels.filter((l) => l.name !== "human-approved");
    core.info(`#${pr.number}: human-approved predates the current head; removed`);
    return null;
  }

  async function checksPassed(sha) {
    const missing = [];
    for (const name of requiredChecks) {
      const { data } = await github.rest.checks.listForRef({ owner, repo, ref: sha, check_name: name, filter: "latest" });
      if (!data.check_runs.some((c) => c.conclusion === "success")) missing.push(name);
    }
    return missing;
  }

  // Blocking review threads. Once Copilot has reviewed the current head, its
  // threads on code that has since changed are resolved here: the rulesets
  // require every thread resolved, and the new review re-raises what still applies.
  // reviewedSha is the head Copilot reviewed (or null); nothing is resolved if
  // the pull request moved past it since, as that head is not reviewed yet.
  async function openThreads(number, reviewedSha) {
    const q = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:1){nodes{author{login}}}}}}}}`;
    const r = await github.graphql(q, { owner, repo, number });
    const { headRefOid } = r.repository.pullRequest;
    const threads = r.repository.pullRequest.reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      author: t.comments.nodes[0]?.author?.login,
    }));
    if (reviewedSha && reviewedSha === headRefOid) {
      for (const t of threads.filter((t) => !t.isResolved && t.isOutdated && isCopilotReviewerLogin(t.author))) {
        await github.graphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`, { id: t.id });
        t.isResolved = true;
        core.info(`#${number}: resolved an outdated Copilot review thread`);
      }
    }
    return blockingThreads(threads).length;
  }

  // Fix requests only count from writers (the dispatcher posts them with the
  // agent token), so a drive-by comment cannot hold a merge back.
  async function agentBusy(number, comments) {
    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: number, per_page: 100 });
    const requestedAt = [];
    for (const c of comments) {
      if (parseFixRequest(c.body) && c.user?.type === "User" && (await canWrite(c.user.login))) requestedAt.push(c.created_at);
    }
    return copilotBusy(timeline, { requestedAt });
  }

  // One comment per PR, edited in place, while a human is needed.
  async function upsertSticky(number, comments, body, { create = true } = {}) {
    const existing = comments.find((c) => c.user?.login === "github-actions[bot]" && c.body?.includes(STICKY));
    const full = `${STICKY}\n${body}`;
    if (existing?.body === full) return;
    if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: full });
    else if (create) await github.rest.issues.createComment({ owner, repo, issue_number: number, body: full });
  }

  function humanNeededComment(pr, reasons) {
    const codespace = `https://codespaces.new/${owner}/${repo}/pull/${pr.number}?quickstart=1`;
    return [
      "### 🧑‍⚖️ This pull request needs a human",
      "",
      "The risk gate will not merge it on its own because:",
      "",
      ...reasons.map((r) => `- ${r}`),
      "",
      `[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](${codespace})`,
      "",
      "The Codespace starts the app on this branch (port 3000) with Copilot CLI ready, so you can try the change before approving.",
      "Approve with a pull request review, or add the `human-approved` label (it approves the current head only).",
      `[Gate run](${runUrl})`,
    ].join("\n");
  }

  async function setLabels(pr, risk) {
    const want = `risk:${risk}`;
    const drop = risk === "low" ? "risk:high" : "risk:low";
    const names = pr.labels.map((l) => l.name);
    if (!names.includes(want)) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [want] });
    if (names.includes(drop)) await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: drop }).catch(() => {});
  }

  // Type labels of the issues a PR closes; a ticket without one inherits its
  // parent spec's (triage labels the spec, to-tickets may not label tickets).
  async function linkedTypeLabels(pr) {
    const out = new Set();
    const typeOf = (issue) => issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter((l) => TYPE_LABELS.includes(l));
    for (const n of closingRefs(pr.body, `${owner}/${repo}`).slice(0, 10)) {
      const issue = await github.rest.issues.get({ owner, repo, issue_number: n }).then((r) => r.data, () => null);
      if (!issue || issue.pull_request) continue;
      let types = typeOf(issue);
      if (!types.length) {
        const parent = await github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/parent", { owner, repo, issue_number: n }).then((r) => r.data, () => null);
        if (parent) types = typeOf(parent);
      }
      types.forEach((t) => out.add(t));
    }
    return [...out];
  }

  // Descriptive labels are only added (people may add more); door:one-way
  // follows the body, so it goes when the change becomes a two-way door.
  async function describe(pr) {
    const names = pr.labels.map((l) => l.name);
    const { add, oneWay } = describeLabels({ title: pr.title, body: pr.body, issueLabels: await linkedTypeLabels(pr) });
    const missing = add.filter((l) => !names.includes(l));
    if (missing.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: missing });
    if (!oneWay && names.includes(ONE_WAY_LABEL)) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: ONE_WAY_LABEL }).catch(() => {});
    }
  }

  async function evaluate(number) {
    let { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    if (pr.state !== "open") return;
    const log = (msg) => core.info(`#${number}: ${msg}`);

    if (pr.draft && isCopilotDone(pr)) {
      await github.graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`, { id: pr.node_id });
      log("Copilot finished: marked ready for review");
      ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    }

    await recordLabelApproval(number);
    await describe(pr);

    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
    const labels = pr.labels.map((l) => l.name);
    let { risk, reasons, lines } = classifyRisk({
      files,
      labels,
      door: titleType(pr.title).breaking ? "one-way" : mergeDangerDoor(pr.body),
    });
    if (isSpecBranch(pr.head.ref) && !autoMergeIntegration) {
      risk = "high";
      reasons = [`integration PR for ${pr.head.ref}`, ...reasons];
    }
    if (isLocalSpecBranch(pr.head.ref)) {
      risk = "high";
      reasons = [`spec built locally on ${pr.head.ref}`, ...reasons];
    }
    // Only branches in this repository (pushed by writers or the cloud agent)
    // can merge without a human.
    if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
      risk = "high";
      reasons = ["opened from a fork", ...reasons];
    }
    await setLabels(pr, risk);

    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
    const { approvers, blockers } = humanApprovals(reviews, { headSha: pr.head.sha, author: pr.user.login });
    const writers = [];
    for (const a of approvers) if (await canWrite(a)) writers.push(a);
    const viaLabel = await labelApprover(pr);
    if (viaLabel) writers.push(viaLabel);

    let state;
    let description;
    if (blockers.length) {
      state = "failure";
      description = `Changes requested by ${blockers.join(", ")}`;
    } else if (risk === "low") {
      state = "success";
      description = `Low risk (${lines} lines, ${files.length} files)`;
    } else if (writers.length) {
      state = "success";
      description = `High risk, approved by ${writers.join(", ")}`;
    } else {
      state = "pending";
      // Lead with the action: the checks box shows only the first ~140 characters.
      description = `Needs a human: approve in a review or add human-approved. High risk: ${reasons.join("; ")}`;
    }
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state,
      context: CONTEXT,
      description: description.slice(0, 140),
      target_url: runUrl,
    });
    log(`${state}: ${description}`);
    core.summary.addRaw(`- #${number} **${risk}** risk, \`${state}\`: ${description}\n`);

    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
    if (state === "pending" && !pr.draft) await upsertSticky(number, comments, humanNeededComment(pr, reasons));
    else if (state === "success") {
      // Keep why it was high risk, so the edited comment still explains the hold.
      const done = risk === "high"
        ? [`### ✅ Approved by ${writers.join(", ")}`, "", "It needed a human because:", "", ...reasons.map((r) => `- ${r}`)].join("\n")
        : "### ✅ Now low risk: no human needed";
      await upsertSticky(number, comments, `${done}\n\n[Gate run](${runUrl})`, { create: false });
    }

    if (state !== "success" || pr.draft) return;
    if (pr.base.ref === repoInfo.default_branch && !autoMergeDefault) return log("auto-merge into the default branch is off");
    if (!isSpecBranch(pr.base.ref) && pr.base.ref !== repoInfo.default_branch) return log(`base ${pr.base.ref} is not managed by the factory`);

    if (await agentBusy(number, comments)) return log("the Copilot cloud agent is working on this pull request");
    // A session that died before its wrap-up leaves "[WIP]": the squash commit
    // would carry it and the description is unfinished. The dispatcher retries.
    if (isCopilotUnfinished(pr)) return log("the agent has not finished: the title still starts with [WIP]");
    const missing = await checksPassed(pr.head.sha);
    if (missing.length) return log(`waiting for checks: ${missing.join(", ")}`);
    const copilotReviewed = reviews.some((r) => isCopilotReview(r) && r.commit_id === pr.head.sha);
    if (requireCopilotReview && !copilotReviewed) {
      const requested = (pr.requested_reviewers || []).some((u) => /copilot/i.test(u.login));
      if (!requested) {
        await github.rest.pulls
          .requestReviewers({ owner, repo, pull_number: number, reviewers: [COPILOT_REVIEWER] })
          .then(() => log("requested a Copilot review of this head"))
          .catch((e) => log(`could not request a Copilot review (${e.message})`));
      }
      return log("waiting for the Copilot code review of this head");
    }
    const threads = await openThreads(number, copilotReviewed ? pr.head.sha : null);
    if (threads) {
      // The dispatcher holds the token @copilot answers to: wake its fix loop
      // when a review lands (its own schedule catches the rest).
      if (context.eventName === "pull_request_review") {
        await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: "dispatch.yml", ref: repoInfo.default_branch });
      }
      return log(`${threads} blocking review thread(s): the dispatcher's fix loop handles Copilot's, a human resolves the rest`);
    }

    try {
      await github.rest.pulls.merge({ owner, repo, pull_number: number, sha: pr.head.sha, merge_method: "squash" });
    } catch (e) {
      return log(`merge refused: ${e.message}`);
    }
    log(`merged into ${pr.base.ref}`);
    await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: "dispatch.yml", ref: repoInfo.default_branch });
  }

  // First attempts only, so a real breakage is never retried in a loop.
  async function rerunInfraFailure() {
    const run = context.payload.workflow_run;
    if (!run || run.conclusion === "success" || (run.run_attempt ?? 1) > 1) return;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { owner, repo, run_id: run.id, per_page: 100 });
    if (!isInfraFailure(run, jobs)) return;
    await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id });
    core.info(`${run.name} run ${run.id} failed (${run.conclusion}) without a failing step: re-running its failed jobs once`);
    core.summary.addRaw(`- Re-ran the failed jobs of [${run.name} #${run.run_number}](${run.html_url}): infrastructure failure\n`);
  }
  await rerunInfraFailure().catch((e) => core.warning(`could not re-run the CI run: ${e.message}`));

  // A merged pull request (by a human, or by this gate on an earlier run)
  // frees the next tickets: start the dispatcher now rather than at its next
  // schedule. It runs with the agent token, which pull_request_target into a
  // factory/spec-* branch cannot reach, so it is dispatched on the default branch.
  if (context.eventName === "pull_request_target" && context.payload.action === "closed") {
    if (!context.payload.pull_request.merged) return;
    await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: "dispatch.yml", ref: repoInfo.default_branch });
    return core.info(`#${context.payload.pull_request.number} merged: dispatcher started`);
  }

  for (const n of await prNumbers()) await evaluate(n);
  await core.summary.write();
};

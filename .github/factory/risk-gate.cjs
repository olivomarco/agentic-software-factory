// Risk gate (run by risk-gate.yml through actions/github-script with
// GITHUB_TOKEN). For each pull request it evaluates, it:
//   - marks Copilot's draft ready once Copilot has finished;
//   - records a `human-approved` label as an approval of the current head only;
//   - classifies the change (policy.cjs) and sets `risk:low` / `risk:high`;
//   - publishes the commit status `factory/risk-gate`: success when the risk
//     is low or a human approved the current head, pending otherwise;
//   - asks Copilot to review the current head when it has not, and merges
//     when the gate, the required checks and that review all pass and no
//     review thread is open, then wakes the dispatcher.
const { classifyRisk, isCopilotDone, humanApprovals, isSpecBranch } = require("./policy.cjs");

const CONTEXT = "factory/risk-gate";
// Records a `human-approved` label against the exact head it was added on.
const APPROVAL_CONTEXT = "factory/human-approval";
const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";
const isCopilotReview = (r) => r.user?.type === "Bot" && r.user.login === COPILOT_REVIEWER;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const requiredChecks = (process.env.REQUIRED_CHECKS || "test").split(",").map((s) => s.trim()).filter(Boolean);
  const requireCopilotReview = process.env.REQUIRE_COPILOT_REVIEW !== "false";
  const autoMergeDefault = process.env.AUTO_MERGE_DEFAULT_BRANCH !== "false";
  const autoMergeIntegration = process.env.AUTO_MERGE_INTEGRATION === "true";
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });

  async function canWrite(login) {
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

  async function openThreads(number) {
    const q = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}`;
    const r = await github.graphql(q, { owner, repo, number });
    return r.repository.pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved).length;
  }

  async function setLabels(pr, risk) {
    const want = `risk:${risk}`;
    const drop = risk === "low" ? "risk:high" : "risk:low";
    const names = pr.labels.map((l) => l.name);
    if (!names.includes(want)) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [want] });
    if (names.includes(drop)) await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: drop }).catch(() => {});
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

    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
    const labels = pr.labels.map((l) => l.name);
    let { risk, reasons, lines } = classifyRisk({ files, labels });
    if (isSpecBranch(pr.head.ref) && !autoMergeIntegration) {
      risk = "high";
      reasons = [`integration PR for ${pr.head.ref}`, ...reasons];
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
      description = `High risk: needs human approval. ${reasons.join("; ")}`;
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

    if (state !== "success" || pr.draft) return;
    if (pr.base.ref === repoInfo.default_branch && !autoMergeDefault) return log("auto-merge into the default branch is off");
    if (!isSpecBranch(pr.base.ref) && pr.base.ref !== repoInfo.default_branch) return log(`base ${pr.base.ref} is not managed by the factory`);

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
    const threads = await openThreads(number);
    if (threads) return log(`${threads} unresolved review thread(s): a human or @copilot has to address them`);

    try {
      await github.rest.pulls.merge({ owner, repo, pull_number: number, sha: pr.head.sha, merge_method: "squash" });
    } catch (e) {
      return log(`merge refused: ${e.message}`);
    }
    log(`merged into ${pr.base.ref}`);
    await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: "dispatch.yml", ref: repoInfo.default_branch });
  }

  for (const n of await prNumbers()) await evaluate(n);
  await core.summary.write();
};

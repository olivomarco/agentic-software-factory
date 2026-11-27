// Weekly scorecard (scorecard.yml): reads the last 14 days of pull requests,
// factory comments, workflow runs and default-branch commits, and posts one
// "[factory] Scorecard" issue comparing the last 7 days with the 7 before.
// The previous scorecard issue is closed. Metrics: scorecard() in policy.cjs.
const { scorecard, scorecardTable } = require("./policy.cjs");

const DAY = 24 * 60 * 60 * 1000;
const BOT = "github-actions[bot]";
const LABEL = "factory:scorecard";

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const to = Date.now();
  const from = to - 7 * DAY;
  const start = to - 14 * DAY;
  const since = new Date(start).toISOString();
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });

  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 100 }, (res, done) => {
    if (res.data.some((p) => Date.parse(p.updated_at) < start)) done();
    return res.data.filter((p) => Date.parse(p.updated_at) >= start);
  });
  const rows = [];
  for (const p of prs) {
    // pulls.list has no merged_by: ask only for the agent's merged PRs.
    let mergedBy = null;
    if (p.merged_at && /^copilot\//.test(p.head.ref) && Date.parse(p.merged_at) >= start) {
      mergedBy = (await github.rest.pulls.get({ owner, repo, pull_number: p.number })).data.merged_by?.login ?? null;
    }
    rows.push({ head_ref: p.head.ref, created_at: p.created_at, merged_at: p.merged_at, closed_at: p.closed_at, merged_by: mergedBy, labels: p.labels.map((l) => l.name) });
  }
  const comments = await github.paginate(github.rest.issues.listCommentsForRepo, { owner, repo, since, per_page: 100 });
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, created: `>=${since}`, per_page: 100 });
  const commits = (await github.paginate(github.rest.repos.listCommits, { owner, repo, sha: repoInfo.default_branch, since, per_page: 100 })).map((c) => ({
    message: c.commit.message,
    date: c.commit.committer?.date,
  }));

  const data = { prs: rows, comments, runs, commits };
  const current = scorecard({ ...data, from, to });
  const previous = scorecard({ ...data, from: start, to: from });
  const date = new Date(to).toISOString().slice(0, 10);
  const body = [
    `Factory scorecard for the 7 days to ${date}, from GitHub data only (no model). [Scorecard run](${runUrl})`,
    "",
    scorecardTable(current, previous),
    "",
    "How to read it: success rate and *merged by the factory* should rise as trust grows; human-handled PRs, fix rounds, retries and failed sessions are the cost of supervision; reverts are escaped defects. Sessions and reviews are what Copilot bills for.",
  ].join("\n");
  core.summary.addRaw(body).write();

  const older = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", labels: LABEL, per_page: 100 });
  const { data: issue } = await github.rest.issues.create({ owner, repo, title: `[factory] Scorecard ${date}`, labels: [LABEL], body });
  for (const o of older.filter((i) => i.user?.login === BOT)) {
    await github.rest.issues.update({ owner, repo, issue_number: o.number, state: "closed", state_reason: "completed" });
  }
  core.info(`posted #${issue.number}`);
};

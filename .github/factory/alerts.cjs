// Alerts (alerts.yml): tells the factory's owners when something waits for a
// human, so nobody has to watch the board.
//   - an issue or PR gets agent:failed, factory:failure or needs-human: one
//     comment @-mentioning FACTORY_OWNERS (GitHub notifies them by mail, web
//     and mobile), once per time the label is added;
//   - a factory workflow fails on the default branch: one open
//     "[factory] <name> is failing" issue, closed when it next succeeds;
//   - the daily agent session cap holds work back: one open
//     "[factory] Agent session cap reached" issue, closed when there is room.
// FACTORY_ALERT_WEBHOOK (optional secret) also gets each alert as
// {"text": ...}: a Slack incoming webhook, or a Teams workflow that posts it.
const { ATTENTION_LABELS, alertMarker, alertDue, mentions } = require("./policy.cjs");
const { agentSessionsLastDay } = require("./sessions.cjs");

const BOT = "github-actions[bot]";
const WATCHED = ["Dispatch", "Risk gate", "Project sync", "Evidence publish"];
const CAP_TITLE = "[factory] Agent session cap reached";
const HINTS = {
  "agent:failed": "The cloud agent could not finish this ticket, even after a retry. Take it over, or use **Retry** in the factory cockpit.",
  "factory:failure": "A factory workflow failed here; the comments and linked runs say where.",
  "needs-human": "The automatic loop stopped here: resolve the review threads or finish the change, then approve.",
};

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const who = mentions(process.env.OWNERS || (repoInfo.owner.type === "User" ? owner : ""));
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  async function notify(text, url) {
    core.info(`alert: ${text}`);
    if (!process.env.WEBHOOK) return;
    const res = await fetch(process.env.WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${text}\n${url}` }),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) core.warning(`alert webhook failed: ${res.status}`);
  }

  const openByTitle = async (title) =>
    (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", labels: "factory:failure", per_page: 100 })).find(
      (i) => i.title === title && i.user?.login === BOT,
    );

  // An issue that exists while a condition holds.
  async function condition(title, holds, body, closing) {
    const existing = await openByTitle(title);
    if (holds && !existing) {
      const { data } = await github.rest.issues.create({
        owner,
        repo,
        title,
        labels: ["factory:failure"],
        body: `${who ? `${who} ` : ""}${body}\n\n${alertMarker(["factory:failure"])}`,
      });
      await notify(title, data.html_url);
    } else if (!holds && existing) {
      await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body: `${closing} [Alerts run](${runUrl})` });
      await github.rest.issues.update({ owner, repo, issue_number: existing.number, state: "closed", state_reason: "completed" });
      core.info(`closed #${existing.number} (${title})`);
    }
  }

  // 1. A factory workflow failing (or recovering) on the default branch.
  const run = context.payload.workflow_run;
  if (run && WATCHED.includes(run.name) && run.head_branch === repoInfo.default_branch && !/^pull_request/.test(run.event)) {
    if (["failure", "success"].includes(run.conclusion)) {
      await condition(
        `[factory] ${run.name} is failing`,
        run.conclusion === "failure",
        `The **${run.name}** workflow failed on \`${repoInfo.default_branch}\`: [run #${run.run_number}](${run.html_url}). The factory may be stalled until it is fixed; later failures do not open new issues. This issue closes itself when the workflow next succeeds.`,
        `**${run.name}** succeeded again ([run #${run.run_number}](${run.html_url})).`,
      );
    }
  }

  // 2. The daily cap on agent sessions.
  const cap = Number(process.env.MAX_SESSIONS_PER_DAY || 0);
  if (cap > 0 && process.env.PAUSED !== "true") {
    const used = await agentSessionsLastDay({ github, owner, repo });
    await condition(
      CAP_TITLE,
      used >= cap,
      `The cloud agent started ${used} sessions in the last 24 hours, the cap set by \`FACTORY_MAX_SESSIONS_PER_DAY\` (${cap}). The dispatcher holds new assignments, retries and review fix rounds until the 24-hour window has room; raise the variable to resume sooner. This issue closes itself then.`,
      `Below the cap again (${used} of ${cap} sessions in the last 24 hours); the dispatcher resumes.`,
    );
  }

  // 3. Items waiting for a human.
  const items = new Map();
  for (const label of ATTENTION_LABELS) {
    for (const i of await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", labels: label, per_page: 100 })) items.set(i.number, i);
  }
  for (const item of items.values()) {
    const labels = item.labels.map((l) => l.name || l);
    const events = await github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number: item.number, per_page: 100 });
    const labeledAt = {};
    for (const e of events) if (e.event === "labeled" && e.label?.name) labeledAt[e.label.name] = e.created_at;
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: item.number, per_page: 100 });
    const alerts = comments.filter((c) => c.user?.login === BOT);
    if (item.user?.login === BOT) alerts.push({ body: item.body, created_at: item.created_at });
    const due = alertDue({ labels, labeledAt, alerts });
    if (!due.length) continue;
    const kind = item.pull_request ? "pull request" : "issue";
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.number,
      body: [`🔔 ${who ? `${who} t` : "T"}his ${kind} needs a human (${due.map((l) => `\`${l}\``).join(", ")}).`, "", ...due.map((l) => `- ${HINTS[l]}`), "", alertMarker(due)].join("\n"),
    });
    await notify(`#${item.number} ${item.title} needs a human (${due.join(", ")})`, item.html_url);
  }
};

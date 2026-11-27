// Cloud agent sessions started in the last 24 hours, counted from the agent's
// dynamic workflow runs. Used by the dispatcher (the daily cap) and alerts.
const AGENT_RUN_PATH = "dynamic/copilot-swe-agent/";
const DAY_MS = 24 * 60 * 60 * 1000;

async function agentSessionsLastDay({ github, owner, repo, now = Date.now() }) {
  const since = new Date(now - DAY_MS).toISOString();
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, created: `>=${since}`, per_page: 100 });
  return runs.filter((r) => r.path?.startsWith(AGENT_RUN_PATH)).length;
}

module.exports = { AGENT_RUN_PATH, agentSessionsLastDay };

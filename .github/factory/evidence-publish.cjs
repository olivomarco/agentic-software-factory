// Publishes the CI screenshots (evidence-publish.yml, a workflow_run of
// Evidence). Runs from the default branch with a write token, so it trusts
// nothing in the artifact: only PNG files with a known name pattern
// (isEvidenceShot), under a size cap, for the pull request whose current head
// is the run's head. Images go to the `factory-evidence` branch; one comment
// per pull request is created or updated.
const fs = require("node:fs");
const path = require("node:path");
const { EVIDENCE_MARKER, isEvidenceShot, evidenceComment } = require("./policy.cjs");

const BRANCH = "factory-evidence";
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 48;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

module.exports = async ({ github, context, core, dir }) => {
  const { owner, repo } = context.repo;
  const run = context.payload.workflow_run;
  const sha = run.head_sha;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("unexpected head SHA");

  let pr = run.pull_requests?.[0]?.number;
  if (!pr) {
    const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: "open", per_page: 100 });
    pr = open.find((p) => p.head.sha === sha)?.number;
  }
  if (!pr) return core.info(`no open pull request at ${sha}`);
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: pr });
  if (current.head.sha !== sha) return core.info(`#${pr} moved on to ${current.head.sha}; skipping stale screenshots`);

  const names = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!isEvidenceShot(name) || !stat.isFile() || stat.size > MAX_BYTES) return false;
    const head = Buffer.alloc(8);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    return head.equals(PNG);
  }).slice(0, MAX_FILES);
  if (!names.length) return core.info("no screenshots to publish");

  const prefix = `pr-${pr}/${sha.slice(0, 12)}`;
  const tree = [];
  for (const name of names) {
    const { data: blob } = await github.rest.git.createBlob({ owner, repo, content: fs.readFileSync(path.join(dir, name)).toString("base64"), encoding: "base64" });
    tree.push({ path: `${prefix}/${name}`, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Other pull requests publish at the same time: retry on a moved branch.
  let commit;
  for (let attempt = 1; ; attempt++) {
    const parent = await github.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` }).then((r) => r.data.object.sha, (e) => (e.status === 404 ? null : Promise.reject(e)));
    const base = parent ? (await github.rest.git.getCommit({ owner, repo, commit_sha: parent })).data.tree.sha : undefined;
    const { data: t } = await github.rest.git.createTree({ owner, repo, tree, ...(base && { base_tree: base }) });
    ({ data: commit } = await github.rest.git.createCommit({ owner, repo, message: `evidence: #${pr} at ${sha.slice(0, 7)}`, tree: t.sha, parents: parent ? [parent] : [] }));
    try {
      if (parent) await github.rest.git.updateRef({ owner, repo, ref: `heads/${BRANCH}`, sha: commit.sha });
      else await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: commit.sha });
      break;
    } catch (e) {
      if (attempt >= 5 || ![409, 422].includes(e.status)) throw e;
      core.info(`${BRANCH} moved (attempt ${attempt}); retrying`);
    }
  }

  const body = evidenceComment({
    names,
    sha,
    runUrl: run.html_url,
    url: (name) => `https://github.com/${owner}/${repo}/blob/${commit.sha}/${prefix}/${name}?raw=true`,
  });
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
  const mine = comments.find((c) => c.user?.login === "github-actions[bot]" && c.body?.startsWith(EVIDENCE_MARKER));
  if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  else await github.rest.issues.createComment({ owner, repo, issue_number: pr, body });
  core.info(`#${pr}: published ${names.length} screenshot(s)`);
};

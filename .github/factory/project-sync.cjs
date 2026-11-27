// Keeps the Project board in step with the factory: adds every issue and pull
// request of the repository and sets Status (the factory stage), Kind and Risk
// from labels and state (policy.cjs projectValues). Deterministic and
// idempotent: each run compares and writes only what changed.
//
// `github` reads the repository (GITHUB_TOKEN). `project` writes the board: a
// classic token with the `project` scope, because fine-grained tokens cannot
// reach user-owned projects.
const { PROJECT_FIELDS, projectValues } = require("./policy.cjs");

module.exports = async function projectSync({ github, project, context, core }) {
  const { owner, repo } = context.repo;
  const url = process.env.PROJECT_URL || "";
  const m = url.match(/github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/);
  if (!m) return core.setFailed(`FACTORY_PROJECT_URL is not a project URL: "${url}"`);
  const [, kind, login, num] = m;
  const backfill = process.env.BACKFILL === "true";
  const sinceDays = Number(process.env.SINCE_DAYS || 3);

  // Project, its single-select fields and every item it already has.
  const ownerField = kind === "users" ? "user" : "organization";
  const head = await project.graphql(
    `query($login: String!, $n: Int!) { ${ownerField}(login: $login) { projectV2(number: $n) {
      id title
      fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
    } } }`,
    { login, n: Number(num) },
  );
  const proj = head[ownerField].projectV2;
  const fields = {};
  for (const f of proj.fields.nodes) if (f?.options) fields[f.name] = { id: f.id, options: Object.fromEntries(f.options.map((o) => [o.name, o.id])) };
  for (const [name, opts] of Object.entries(PROJECT_FIELDS)) {
    const missing = opts.map(([o]) => o).filter((o) => !fields[name]?.options[o]);
    if (missing.length) return core.setFailed(`Project "${proj.title}" lacks ${name} options: ${missing.join(", ")}. Re-run scripts/setup-repo.sh --project.`);
  }

  const items = new Map();
  let after = null;
  do {
    const page = await project.graphql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id
          content { ... on Issue { id } ... on PullRequest { id } }
          fieldValues(first: 30) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } }
        }
      } } } }`,
      { id: proj.id, after },
    );
    const conn = page.node.items;
    for (const it of conn.nodes) {
      if (!it.content?.id) continue;
      const values = {};
      for (const v of it.fieldValues.nodes) if (v?.field?.name) values[v.field.name] = v.name;
      items.set(it.content.id, { id: it.id, values });
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  // Every open issue and pull request, plus anything updated lately (closed
  // and merged ones move to Done). A backfill takes the whole history.
  const all = new Map();
  const list = (params) => github.paginate(github.rest.issues.listForRepo, { owner, repo, per_page: 100, ...params });
  for (const i of await list({ state: "open" })) all.set(i.node_id, i);
  const since = backfill ? undefined : new Date(Date.now() - sinceDays * 86400000).toISOString();
  for (const i of await list({ state: "all", since })) all.set(i.node_id, i);

  const counts = { added: 0, updated: 0, unchanged: 0 };
  const errors = [];
  for (const issue of all.values()) {
    try {
      const want = projectValues(issue);
      let item = items.get(issue.node_id);
      if (!item) {
        const res = await project.graphql(
          `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
          { p: proj.id, c: issue.node_id },
        );
        item = { id: res.addProjectV2ItemById.item.id, values: {} };
        counts.added++;
      }
      let changed = false;
      for (const [name, value] of Object.entries(want)) {
        if ((item.values[name] ?? null) === value) continue;
        changed = true;
        if (value === null) {
          await project.graphql(
            `mutation($p: ID!, $i: ID!, $f: ID!) { clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { clientMutationId } }`,
            { p: proj.id, i: item.id, f: fields[name].id },
          );
        } else {
          await project.graphql(
            `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { clientMutationId } }`,
            { p: proj.id, i: item.id, f: fields[name].id, o: fields[name].options[value] },
          );
        }
      }
      if (changed && items.has(issue.node_id)) counts.updated++;
      else if (!changed) counts.unchanged++;
      core.info(`#${issue.number} ${want.Status} / ${want.Kind}${want.Risk ? ` / ${want.Risk} risk` : ""}${changed ? "" : " (unchanged)"}`);
    } catch (e) {
      errors.push(`#${issue.number}: ${e.message}`);
    }
  }

  const line = `Project "${proj.title}": ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged of ${all.size}${backfill ? " (backfill)" : ""}`;
  core.info(line);
  await core.summary.addRaw(`${line}\n`).write();
  if (errors.length) core.setFailed(`${errors.length} item(s) failed:\n${errors.join("\n")}`);
};

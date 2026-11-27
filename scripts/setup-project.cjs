#!/usr/bin/env node
// Shapes the factory's Project board: Status options become the factory's
// stages, Kind and Risk fields are added (all from PROJECT_FIELDS in
// .github/factory/policy.cjs) and the factory's views are created. Safe to
// re-run: it changes only what differs. Called by scripts/setup-repo.sh.
//
// Usage: node scripts/setup-project.cjs OWNER PROJECT_NUMBER
// Needs: gh logged in with the `project` scope.
const { execFileSync } = require("node:child_process");
const { PROJECT_FIELDS } = require("../.github/factory/policy.cjs");

const [login, num] = process.argv.slice(2);
if (!login || !num) {
  console.error("Usage: node scripts/setup-project.cjs OWNER PROJECT_NUMBER");
  process.exit(2);
}

const gh = (args, input) => {
  const out = execFileSync("gh", args, { input: input && JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  return out ? JSON.parse(out) : null;
};
const graphql = (query, variables) => {
  const res = gh(["api", "graphql", "--input", "-"], { query, variables });
  if (res.errors) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res.data;
};

const owner = gh(["api", `users/${login}`]);
const isOrg = owner.type === "Organization";
const ownerField = isOrg ? "organization" : "user";
const load = () =>
  graphql(
    `query($login: String!, $n: Int!) { ${ownerField}(login: $login) { projectV2(number: $n) {
      id
      fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { name } } } }
      views(first: 50) { nodes { name } }
    } } }`,
    { login, n: Number(num) },
  )[ownerField].projectV2;

let project = load();
const options = (list) => list.map(([name, color, description]) => ({ name, color, description }));

for (const [name, list] of Object.entries(PROJECT_FIELDS)) {
  const field = project.fields.nodes.find((f) => f.name === name);
  const want = list.map(([n]) => n);
  if (!field) {
    graphql(
      `mutation($p: ID!, $name: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
        createProjectV2Field(input: { projectId: $p, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $o }) { clientMutationId } }`,
      { p: project.id, name, o: options(list) },
    );
    console.log(`  field ${name} created`);
  } else if (JSON.stringify(field.options?.map((o) => o.name)) !== JSON.stringify(want)) {
    // Replacing the options clears values that used other names; the next
    // project sync writes them again.
    graphql(
      `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
        updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { clientMutationId } }`,
      { f: field.id, o: options(list) },
    );
    console.log(`  field ${name}: options set to the factory's`);
  } else console.log(`  field ${name} up to date`);
}

// Views need the numeric field ids of the REST API.
project = load();
const base = `${isOrg ? "orgs" : "users"}/${login}/projectsV2/${num}`;
const ids = Object.fromEntries(gh(["api", `${base}/fields?per_page=100`]).map((f) => [f.name, f.id]));
const pick = (...names) => names.map((n) => ids[n]).filter(Boolean);
const views = [
  { name: "Factory", layout: "board", filter: "-status:\"Won't fix\"", visible_fields: pick("Title", "Kind", "Risk", "Assignees", "Linked pull requests", "Sub-issues progress") },
  { name: "Needs a human", layout: "table", filter: "is:open status:\"Needs human\",\"Needs attention\",Spec,Triage", visible_fields: pick("Title", "Status", "Kind", "Risk", "Assignees", "Updated") },
  { name: "Specs", layout: "table", filter: "kind:Spec,Ticket", visible_fields: pick("Title", "Status", "Kind", "Parent issue", "Sub-issues progress", "Assignees", "Linked pull requests") },
  { name: "Pull requests", layout: "table", filter: "is:pr", visible_fields: pick("Title", "Status", "Risk", "Assignees", "Reviewers", "Labels", "Updated") },
];
const have = new Set(project.views.nodes.map((v) => v.name));
for (const v of views) {
  if (have.has(v.name)) {
    console.log(`  view ${v.name} exists`);
    continue;
  }
  gh(["api", "-X", "POST", `${base}/views`, "--input", "-"], v);
  console.log(`  view ${v.name} created`);
}

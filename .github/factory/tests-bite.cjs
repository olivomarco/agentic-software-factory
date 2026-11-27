// Tests-bite check (tests-bite.yml): the tests a pull request adds or changes
// must fail on the base branch and pass on the pull request. Runs each changed
// test file with TEST_CMD (default `node --test`) twice: on the checked-out
// head, then in a worktree of the merge base with only those test files copied
// in. Rules live in policy.cjs (biteMode, biteVerdict).
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { biteMode, biteVerdict } = require("./policy.cjs");

const { BASE_SHA, HEAD_REF = "", PR_TITLE = "", TEST_CMD = "node --test", GITHUB_STEP_SUMMARY } = process.env;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const summary = (text) => {
  console.log(text);
  if (GITHUB_STEP_SUMMARY) fs.appendFileSync(GITHUB_STEP_SUMMARY, `${text}\n`);
};

function run(cwd, file) {
  const [cmd, ...args] = TEST_CMD.split(/\s+/);
  const r = spawnSync(cmd, [...args, file], { cwd, encoding: "utf8", timeout: 10 * 60 * 1000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  console.log(`::group::${path.basename(cwd)} ${file} (exit ${r.status})\n${out}\n::endgroup::`);
  return r.status === null ? 1 : r.status;
}

if (!/^[0-9a-f]{40}$/.test(BASE_SHA || "")) throw new Error("BASE_SHA must be a commit SHA");
const base = git("merge-base", BASE_SHA, "HEAD");
const files = git("diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`).split("\n").filter(Boolean);
const plan = biteMode({ title: PR_TITLE, files, headRef: HEAD_REF });
summary(`## Tests bite\n\n**${plan.mode}**: ${plan.reason}`);
if (plan.mode === "skip") process.exit(0);
if (plan.mode === "fail") {
  summary("\nAdd or change a test that fails without the change and passes with it.");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bite-base-"));
let results;
try {
  git("worktree", "add", "--detach", dir, base);
  const bootstrap = path.join(dir, "scripts/bootstrap.sh");
  if (fs.existsSync(bootstrap)) execFileSync("bash", [bootstrap], { cwd: dir, stdio: "inherit" });
  results = plan.tests.map((file) => {
    const head = run(process.cwd(), file);
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(file, path.join(dir, file));
    return { file, head, base: run(dir, file) };
  });
} finally {
  git("worktree", "remove", "--force", dir);
}

summary("\n| Test file | Base | Pull request |\n|---|---|---|");
for (const r of results) summary(`| \`${r.file}\` | ${r.base ? "fails" : "passes"} | ${r.head ? "fails" : "passes"} |`);
const verdict = biteVerdict(results);
summary(`\n${verdict.ok ? "✅" : "❌"} ${verdict.reason}`);
process.exit(verdict.ok ? 0 : 1);

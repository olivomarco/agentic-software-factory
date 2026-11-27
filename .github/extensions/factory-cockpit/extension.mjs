// Extension: factory-cockpit
// A Copilot CLI canvas over the software factory: the triage queue, specs with
// their ticket trees and blockers, and pull requests with their risk gate.
// Buttons map to the factory's own primitives (labels, /spec comments,
// workflow runs) through the signed-in `gh` user. "Grill here" is the only
// place grilling happens: it runs the grill-with-docs skill in this CLI session
// and posts the outcome to the issue, where /spec picks it up.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@microsoft/copilot-sdk/extension";
import { ACTIONS, cloudTicketsInFlight, detectRepo, loadState } from "./github.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const instances = new Map();

// Actions the agent may trigger. Gate actions (approving a spec, starting an
// agent, approving a PR) stay with the human clicking in the canvas.
const AGENT_ACTIONS = ["spec", "retriage", "retriage-failed", "rerun-run", "gate-pr", "dispatch"];

// Grilling can stall on a question words cannot settle (how a state model
// behaves, what a page should look like): offer a throwaway prototype then.
function prototypeLine(repo, number) {
  return `When a question about a state model or a UI cannot be settled in words, offer a throwaway prototype with the prototype skill at ${join(repoRoot, ".github/skills/prototype/SKILL.md")} and build it only if I agree. We are before the spec, so do not fold anything into the real code: put the verdict (and any snippet that pins the decision, such as a reducer or a type) in the summary, and offer to push the prototype to a branch named prototype/issue-${number || "<issue>"}-<slug> in ${repo}, linked from the summary, asking before the push. Never leave prototype files in the working tree on the default branch.`;
}

function grillPrompt(repo, number) {
  const skill = join(repoRoot, ".github/skills/grill-with-docs/SKILL.md");
  return [
    `Grill me about issue #${number} in ${repo}, using the grill-with-docs skill at ${skill} (read it and the files it references first).`,
    `Start by reading the issue and its comments with \`gh issue view ${number} --repo ${repo} --comments\`, including triage's questions, the reporter's answers and any earlier grilling summary, and the code it touches.`,
    "Ask one question at a time with your recommended answer, using the ask_user tool, and keep going until we have a shared understanding.",
    prototypeLine(repo, number),
    `When we are done, post one comment on the issue with \`gh issue comment ${number} --repo ${repo} --body-file -\` titled "## Grilling summary (local session)": the decisions with their reasons, the resolved terms, and anything still open.`,
    "If a term or decision belongs in GLOSSARY.md or docs/adr/, list it in the comment; do not commit files.",
    "Finally, ask me whether to comment /spec on the issue to have the factory write the spec.",
  ].join("\n");
}

// Architecture review: the improve-codebase-architecture skill, in this
// session (its report and grilling need a human), either from scratch or from
// the candidates the weekly architecture scout posted on an issue.
function architecturePrompt(repo, number) {
  const skills = join(repoRoot, ".github/skills");
  return [
    `Run an architecture review of ${repo} (checked out at ${repoRoot}) with the improve-codebase-architecture skill at ${skills}/improve-codebase-architecture/SKILL.md (read it, its HTML-REPORT.md, and the codebase-design, grilling and domain-modeling skills it calls, first).`,
    number > 0
      ? `Start from the candidates the architecture scout posted on issue #${number} (\`gh issue view ${number} --repo ${repo} --comments\`): check them against the current code, drop any that no longer hold, then write the HTML report and open it in the browser.`
      : "Write the HTML report and open it in the browser.",
    "Then ask me which candidate to explore, with the ask_user tool, and grill me through it one question at a time.",
    prototypeLine(repo, number),
    `When we settle on a deepening, file it as an issue with \`gh issue create --repo ${repo} --label refactor --body-file -\`: the problem, the deepened module and its seam, what tests change, and a "## Grilling summary (local session)" with the decisions and their reasons${number > 0 ? `, linking back to #${number}` : ""}. Then ask me whether to comment /spec on it so the factory writes the spec.`,
    "GLOSSARY.md and ADR changes the skill makes stay uncommitted: show me the diff and ask before committing or pushing anything.",
  ].join("\n");
}

function buildPrompt(repo, number) {
  const skills = join(repoRoot, ".github/skills");
  return [
    `Build the approved spec #${number} in ${repo} with the implement-spec skill at ${skills}/implement-spec/SKILL.md (read it, and the implement, tdd, code-review and pr skills it relies on, first). The issue tracker conventions are in ${join(repoRoot, "docs/agents/issue-tracker.md")}.`,
    `The spec is the issue's ## Spec section; its tickets are its sub-issues with blocked-by edges (\`gh api repos/${repo}/issues/${number}/sub_issues\`). The spec is labelled lane:local, so the factory's dispatcher will not hand these tickets to the cloud agent; skip any ticket that is already closed or labelled status:in-progress.`,
    `Use \`local/spec-${number}\` as the integration branch (factory/** is protected and only takes pull requests). Create it from \`factory/spec-${number}\` if that branch exists, since it may hold tickets the cloud agent already merged, otherwise from the default branch. Give each ticket its own worktree and branch, as the skill says.`,
    `Open the draft pull request from local/spec-${number} into the default branch, titled "Spec #${number}: <spec title>", with a body written with the pr skill that starts with "Closes #${number}" and one "Closes #<ticket>" line per ticket, and fill Merge Danger honestly (\`**Door:** one-way\` or \`**Door:** two-way\`).`,
    `Before marking the pull request ready, merge the latest origin/factory/spec-${number} (if it exists) into local/spec-${number} again, so nothing the cloud agent merged there is left behind.`,
    "Ask me before every push. When everything is merged into the integration branch and reviewed, mark the pull request ready: the risk gate treats local/spec-* pull requests as high risk, so a human approves it.",
  ].join("\n");
}

async function stateFor(entry, force = false) {
  if (!force && entry.cache && Date.now() - entry.cache.at < 10_000) return entry.cache.data;
  let data;
  try {
    data = await loadState(entry.repo);
  } catch (e) {
    data = { repo: entry.repo, error: `Could not read ${entry.repo}: ${e.stderr || e.message}` };
  }
  entry.cache = { at: Date.now(), data };
  return data;
}

function push(entry, msg) {
  for (const res of entry.clients) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

async function perform(entry, action, number) {
  if (action === "grill-local") {
    await session.send({ prompt: grillPrompt(entry.repo, number) });
    return `Grilling #${number} in the Copilot CLI chat`;
  }
  if (action === "architecture-local") {
    await session.send({ prompt: architecturePrompt(entry.repo, number > 0 ? number : 0) });
    return number > 0 ? `Architecture review of #${number} in the Copilot CLI chat` : "Architecture review in the Copilot CLI chat";
  }
  if (action === "build-local") {
    if (!(Number.isInteger(number) && number > 0)) throw new CanvasError("bad_input", "A spec number is required");
    const busy = await cloudTicketsInFlight(entry.repo, number);
    if (busy.length) {
      throw new CanvasError(
        "busy",
        `The cloud agent is still working on ${busy.map((n) => `#${n}`).join(", ")}; build locally after those pull requests merge or close.`,
      );
    }
    await ACTIONS["lane-local"](entry.repo, number);
    entry.cache = null;
    await session.send({ prompt: buildPrompt(entry.repo, number) });
    return `Spec #${number} is now lane:local; building it in the Copilot CLI chat`;
  }
  const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!fn) throw new CanvasError("unknown_action", `Unknown action ${action}`);
  if (action !== "dispatch" && !(Number.isInteger(number) && number > 0)) throw new CanvasError("bad_input", "An issue or PR number is required");
  await fn(entry.repo, number);
  entry.cache = null;
  if (action === "dispatch") return "Dispatcher started";
  if (action === "rerun-run") return `Re-running workflow run ${number}`;
  if (action === "retry-agent") return `#${number} is ready for the agent again; the dispatcher picks it up`;
  return `${action} done on #${number}`;
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 10_000) req.destroy();
    });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

async function startServer(entry) {
  const html = await readFile(join(here, "ui.html"), "utf8");
  const prefix = `/${entry.secret}`;
  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    // The random path segment keeps other local pages and sites from driving the cockpit.
    if (!req.url.startsWith(prefix)) return send(404, { message: "not found" });
    const path = req.url.slice(prefix.length) || "/";
    try {
      if (req.method === "GET" && path === "/") return send(200, html, "text/html");
      if (req.method === "GET" && path === "/api/state") return send(200, await stateFor(entry));
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": ok\n\n");
        entry.clients.add(res);
        req.on("close", () => entry.clients.delete(res));
        return;
      }
      if (req.method === "POST" && path === "/api/action") {
        if (req.headers["content-type"] !== "application/json") return send(415, { message: "JSON only" });
        const { action, number } = JSON.parse(await readBody(req));
        return send(200, { message: await perform(entry, action, Number(number)) });
      }
      send(404, { message: "not found" });
    } catch (e) {
      send(e instanceof CanvasError ? 400 : 500, { message: e.stderr?.trim() || e.message });
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}/` };
}

const instanceOf = (ctx) => {
  const entry = instances.get(ctx.instanceId);
  if (!entry) throw new CanvasError("not_open", "Open the cockpit first");
  return entry;
};

function summary(state) {
  if (state.error) return state;
  const byStage = {};
  for (const i of state.issues) (byStage[i.stage] ??= []).push(`#${i.number} ${i.title}`);
  return {
    repo: state.repo,
    issuesByStage: byStage,
    failedRuns: (state.failedRuns || []).map((r) => ({ id: r.id, workflow: r.workflow, title: r.title, conclusion: r.conclusion, url: r.url })),
    specs: state.specs.map((s) => ({
      number: s.number,
      title: s.title,
      stage: s.stage,
      tickets: s.tickets.map((t) => `#${t.number} ${t.state}${t.blockedBy ? ` blocked by ${t.blockedBy}` : ""}`),
    })),
    pulls: state.pulls.map((p) => ({ number: p.number, title: p.title, base: p.base, risk: p.risk, gate: p.gate, gateText: p.gateText, draft: p.draft })),
    recentlyClosed: state.closed && {
      issues: state.closed.issues.map((i) => `#${i.number} ${i.title} (${i.reason || "closed"})`),
      pulls: state.closed.pulls.map((p) => `#${p.number} ${p.title} (${p.state} into ${p.base})`),
    },
  };
}

const session = await joinSession({
  canvases: {
    definitions: [
      createCanvas({
        id: "factory-cockpit",
        displayName: "Factory cockpit",
        description: "Software factory dashboard: triage queue, grilling, spec approval, ticket trees with blockers and PR risk for a GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "OWNER/REPO; defaults to the repository this extension lives in" },
            tab: { type: "string", enum: ["queue", "specs", "pulls"] },
          },
        },
        actions: [
          {
            name: "get_state",
            description:
              "Return the factory state shown in the cockpit: open issues by stage (attention = agent:failed or factory:failure), failed workflow runs, specs with ticket trees, PRs with risk and gate status, and the most recently closed issues and pull requests.",
            handler: async (ctx) => summary(await stateFor(instanceOf(ctx), true)),
          },
          {
            name: "show",
            description:
              "Switch the cockpit to a tab, choose open, closed or all items, and set its filter, then refresh it. The filter takes free text and GitHub-style qualifiers: is:open|closed|merged|unmerged|done|wontfix|agent|blocked|failed|human|spec|draft, label:NAME, risk:low|high, base:BRANCH, author:LOGIN, assignee:LOGIN; prefix with - to negate. An empty filter clears it.",
            inputSchema: {
              type: "object",
              properties: {
                tab: { type: "string", enum: ["queue", "specs", "pulls"] },
                state: { type: "string", enum: ["open", "closed", "all"] },
                filter: { type: "string" },
              },
            },
            handler: async (ctx) => {
              const entry = instanceOf(ctx);
              entry.cache = null;
              const { tab, state, filter } = ctx.input || {};
              push(entry, { tab, view: state, filter, refresh: true });
              return { ok: true };
            },
          },
          {
            name: "run",
            description: `Run a non-gate factory action: ${AGENT_ACTIONS.join(", ")}. Approving specs, starting the agent and approving PRs are left to the human in the canvas.`,
            inputSchema: {
              type: "object",
              properties: { action: { type: "string", enum: AGENT_ACTIONS }, number: { type: "integer" } },
              required: ["action"],
            },
            handler: async (ctx) => {
              const entry = instanceOf(ctx);
              const { action, number } = ctx.input || {};
              if (!AGENT_ACTIONS.includes(action)) throw new CanvasError("forbidden", `${action} is a human gate; click it in the cockpit`);
              const message = await perform(entry, action, Number(number));
              push(entry, { refresh: true });
              return { message };
            },
          },
        ],
        open: async (ctx) => {
          let entry = instances.get(ctx.instanceId);
          if (!entry) {
            const repo = ctx.input?.repo || (await detectRepo(repoRoot).catch(() => detectRepo(process.cwd())));
            entry = { repo, secret: randomBytes(16).toString("hex"), clients: new Set(), cache: null };
            Object.assign(entry, await startServer(entry));
            instances.set(ctx.instanceId, entry);
          }
          if (ctx.input?.tab) push(entry, { tab: ctx.input.tab });
          return { title: `Factory cockpit: ${entry.repo}`, url: entry.url };
        },
        onClose: async (ctx) => {
          const entry = instances.get(ctx.instanceId);
          if (!entry) return;
          instances.delete(ctx.instanceId);
          for (const res of entry.clients) res.end();
          await new Promise((ok) => entry.server.close(() => ok()));
        },
      }),
    ],
  },
});

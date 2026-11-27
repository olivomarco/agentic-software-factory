// Extension: factory-cockpit
// A Copilot CLI canvas over the software factory: the triage queue, specs with
// their ticket trees and blockers, and pull requests with their risk gate.
// Buttons map to the factory's own primitives (labels, /grill and /spec
// comments, workflow runs) through the signed-in `gh` user. "Grill here" runs
// the grill-with-docs skill in this CLI session and posts the outcome to the
// issue, so local and asynchronous grilling end up in the same place.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@microsoft/copilot-sdk/extension";
import { ACTIONS, detectRepo, loadState } from "./github.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const instances = new Map();

// Actions the agent may trigger. Gate actions (approving a spec, starting an
// agent, approving a PR) stay with the human clicking in the canvas.
const AGENT_ACTIONS = ["grill", "spec", "retriage", "gate-pr", "dispatch"];

function grillPrompt(repo, number) {
  const skill = join(repoRoot, ".github/skills/grill-with-docs/SKILL.md");
  return [
    `Grill me about issue #${number} in ${repo}, using the grill-with-docs skill at ${skill} (read it and the files it references first).`,
    `Start by reading the issue and its comments with \`gh issue view ${number} --repo ${repo} --comments\`, including any earlier /grill rounds, and the code it touches.`,
    "Ask one question at a time with your recommended answer, using the ask_user tool, and keep going until we have a shared understanding.",
    `When we are done, post one comment on the issue with \`gh issue comment ${number} --repo ${repo} --body-file -\` titled "## Grilling summary (local session)": the decisions with their reasons, the resolved terms, and anything still open.`,
    "If a term or decision belongs in GLOSSARY.md or docs/adr/, list it in the comment; do not commit files.",
    "Finally, ask me whether to comment /spec on the issue to have the factory write the spec.",
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
  const fn = ACTIONS[action];
  if (!fn) throw new CanvasError("unknown_action", `Unknown action ${action}`);
  if (action !== "dispatch" && !(Number.isInteger(number) && number > 0)) throw new CanvasError("bad_input", "An issue or PR number is required");
  await fn(entry.repo, number);
  entry.cache = null;
  return action === "dispatch" ? "Dispatcher started" : `${action} done on #${number}`;
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
    specs: state.specs.map((s) => ({
      number: s.number,
      title: s.title,
      stage: s.stage,
      tickets: s.tickets.map((t) => `#${t.number} ${t.state}${t.blockedBy ? ` blocked by ${t.blockedBy}` : ""}`),
    })),
    pulls: state.pulls.map((p) => ({ number: p.number, title: p.title, base: p.base, risk: p.risk, gate: p.gate, gateText: p.gateText, draft: p.draft })),
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
            description: "Return the factory state shown in the cockpit: open issues by stage, specs with ticket trees, PRs with risk and gate status.",
            handler: async (ctx) => summary(await stateFor(instanceOf(ctx), true)),
          },
          {
            name: "show",
            description: "Switch the cockpit to a tab and refresh it.",
            inputSchema: { type: "object", properties: { tab: { type: "string", enum: ["queue", "specs", "pulls"] } } },
            handler: async (ctx) => {
              const entry = instanceOf(ctx);
              entry.cache = null;
              push(entry, { tab: ctx.input?.tab, refresh: true });
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

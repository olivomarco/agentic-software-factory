const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const STATIC_FILES = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/logic.js": ["logic.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
};

function createApp() {
  const todos = [];
  let nextId = 1;

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
  }

  async function handleApi(req, res, url) {
    const match = url.pathname.match(/^\/api\/todos(?:\/(\d+))?$/);
    if (!match) return send(res, 404, { error: "Not found" });
    const id = match[1] ? Number(match[1]) : null;

    if (!id && req.method === "GET") return send(res, 200, todos);

    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return send(res, 400, { error: "title is required" });
      const todo = { id: nextId++, title, done: false };
      todos.push(todo);
      return send(res, 201, todo);
    }

    const todo = todos.find((t) => t.id === id);
    if (id && !todo) return send(res, 404, { error: "Todo not found" });

    if (id && req.method === "PATCH") {
      const body = await readJson(req);
      if (typeof body.done === "boolean") todo.done = body.done;
      return send(res, 200, todo);
    }

    if (id && req.method === "DELETE") {
      todos.splice(todos.indexOf(todo), 1);
      res.writeHead(204);
      return res.end();
    }

    return send(res, 405, { error: "Method not allowed" });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      const file = STATIC_FILES[url.pathname];
      if (req.method === "GET" && file) {
        res.writeHead(200, { "Content-Type": file[1] });
        return res.end(fs.readFileSync(path.join(FRONTEND_DIR, file[0])));
      }
      return send(res, 404, { error: "Not found" });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
}

module.exports = { createApp };

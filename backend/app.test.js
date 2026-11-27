const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./app");

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const json = (method, path, body) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("creates and lists todos", async () => {
  const created = await json("POST", "/api/todos", { title: "  Write tests " });
  assert.equal(created.status, 201);
  const todo = await created.json();
  assert.equal(todo.title, "Write tests");
  assert.equal(todo.done, false);

  const list = await (await json("GET", "/api/todos")).json();
  assert.ok(list.some((t) => t.id === todo.id));
});

test("rejects a todo without a title", async () => {
  const res = await json("POST", "/api/todos", { title: "   " });
  assert.equal(res.status, 400);
});

test("toggles and deletes a todo", async () => {
  const todo = await (await json("POST", "/api/todos", { title: "Toggle me" })).json();

  const patched = await (await json("PATCH", `/api/todos/${todo.id}`, { done: true })).json();
  assert.equal(patched.done, true);

  assert.equal((await json("DELETE", `/api/todos/${todo.id}`)).status, 204);
  assert.equal((await json("DELETE", `/api/todos/${todo.id}`)).status, 404);
});

test("serves the frontend", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Todo/);
});

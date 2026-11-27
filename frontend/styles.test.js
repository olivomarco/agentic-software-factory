const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../backend/app");

test("served todo title styles allow long text to wrap within its row", async () => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${server.address().port}/styles.css`);
    assert.equal(response.status, 200);
    const css = await response.text();
    const titleRule = css.match(/li\s+span\s*\{([^}]*)\}/);
    assert.ok(titleRule, "todo title rule exists");
    assert.match(titleRule[1], /\bmin-width\s*:\s*0\s*;/);
    assert.match(titleRule[1], /\boverflow-wrap\s*:\s*anywhere\s*;/);
  } finally {
    server.close();
  }
});

test("served completed todo styles keep titles struck through and muted", async () => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${server.address().port}/styles.css`);
    assert.equal(response.status, 200);
    const css = await response.text();
    const doneRule = css.match(/\.done\s*\{([^}]*)\}/);
    assert.ok(doneRule, "completed todo rule exists");
    assert.match(doneRule[1], /\btext-decoration\s*:\s*line-through\s*;/);
    assert.match(doneRule[1], /\bcolor\s*:\s*#6b627a\s*;/i);
  } finally {
    server.close();
  }
});

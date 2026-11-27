const { test } = require("node:test");
const assert = require("node:assert/strict");
const { remainingCount, summaryText } = require("./logic");

test("counts only incomplete todos", () => {
  assert.equal(remainingCount([{ done: true }, { done: false }, { done: false }]), 2);
});

test("summary text pluralises", () => {
  assert.equal(summaryText([{ done: false }]), "1 item left");
  assert.equal(summaryText([]), "0 items left");
});

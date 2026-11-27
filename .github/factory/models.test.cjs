const test = require("node:test");
const assert = require("node:assert");
const models = require("./models.json");

test("models.json only names known stages with non-empty model ids", () => {
  const stages = new Set(["implement"]);
  for (const [stage, model] of Object.entries(models)) {
    assert.ok(stages.has(stage), `unknown stage ${stage}`);
    assert.match(model, /^[\w.-]+$/, `bad model id for ${stage}`);
  }
});

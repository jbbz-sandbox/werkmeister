// context_strategy → strategy. Absent means jit; unknown throws; a malformed
// workspace.yml reads as jit and prints nothing (notes context feeds a hook).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { STRATEGY_IDS, readContextStrategy, strategyFor } from "./dist/strategies/index.js";

function ws(yml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-reg-"));
  fs.mkdirSync(path.join(root, ".sandbox"));
  if (yml !== null) fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), yml);
  return root;
}

test("no workspace.yml, or no field → jit", () => {
  assert.equal(readContextStrategy(ws(null)), "jit");
  assert.equal(readContextStrategy(ws("feature: demo\n")), "jit");
  assert.equal(readContextStrategy(ws("context_strategy: ''\n")), "jit");
});

test("icm → the icm strategy", () => {
  const root = ws("context_strategy: icm\n");
  assert.equal(readContextStrategy(root), "icm");
  assert.equal(strategyFor(root).id, "icm");
});

test("an unknown value throws, naming the choices", () => {
  assert.throws(() => readContextStrategy(ws("context_strategy: foo\n")), (err) => {
    assert.equal(err.code, "UNKNOWN_CONTEXT_STRATEGY");
    assert.match(err.message, /'foo'.*jit, icm/);
    return true;
  });
});

test("malformed yaml reads as jit and prints nothing", async () => {
  const c = collectingReporter();
  const id = await withReporter(c, async () => readContextStrategy(ws("context_strategy: [\n")));
  assert.equal(id, "jit");
  assert.equal(c.text(), "");
});

test("the workspace schema's enum is the registry", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "..", "apps", "cli", "infra", "schemas", "workspace.schema.json"), "utf8"),
  );
  assert.deepEqual(schema.properties.context_strategy.enum, [...STRATEGY_IDS]);
});

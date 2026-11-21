// SW-773: every run uses a current model (claude-opus-5-5), and a price table that
// lacked it left estUsd null for every closed workspace, silently.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { rollUpUsage } from "../dist/harness/claude/usage.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { DEFAULT_MODEL_PRICING_YAML } from "../dist/scaffold.js";

const tally = (model) => ({
  sessionId: "s1",
  title: "t",
  updatedAt: "2026-11-15T00:00:00.000Z",
  reduction: {
    byModel: new Map([[model, { input: 1e6, output: 0, cacheCreation: 0, cacheRead: 0 }]]),
    firstTurn: null,
    lastTurn: null,
    turns: 1,
    models: [model],
  },
});

// Points the price table at *yaml* (null = no file, so the built-in defaults apply).
async function withPricing(yaml, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-"));
  const prev = process.env.WERKMEISTER_MODEL_PRICING_YAML;
  const file = path.join(dir, "model-pricing.yaml");
  if (yaml != null) fs.writeFileSync(file, yaml);
  process.env.WERKMEISTER_MODEL_PRICING_YAML = file;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_MODEL_PRICING_YAML;
    else process.env.WERKMEISTER_MODEL_PRICING_YAML = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const model of [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
]) {
  test(`${model} is priced by the built-in defaults`, async () => {
    const u = await withPricing(null, () => rollUpUsage("ws", [tally(model)]));
    assert.ok(u.estUsd > 0, `estUsd for ${model}: ${u.estUsd}`);
  });
}

test("an existing model-pricing.yaml seeded before the current models still prices them", async () => {
  const old =
    "models:\n  claude-opus-4-8: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }\n";
  const u = await withPricing(old, () => rollUpUsage("ws", [tally("claude-opus-5-5")]));
  assert.equal(u.estUsd, 4); // 1M input tokens at the default $4/M
});

test("the file's own rate wins over the default", async () => {
  const own = "models:\n  claude-opus-5-5: { input: 7, output: 0, cacheWrite: 0, cacheRead: 0 }\n";
  const u = await withPricing(own, () => rollUpUsage("ws", [tally("claude-opus-5-5")]));
  assert.equal(u.estUsd, 7);
});

test("a model with no rate warns once, naming the model and the file", async () => {
  const reporter = collectingReporter();
  await withPricing(null, () =>
    withReporter(reporter, async () => {
      await rollUpUsage("ws", [tally("claude-unpriced-9")]);
      await rollUpUsage("ws", [tally("claude-unpriced-9")]);
    }),
  );
  const hits = reporter.text().match(/claude-unpriced-9/g) ?? [];
  assert.equal(hits.length, 1, reporter.text());
  assert.match(reporter.text(), /model-pricing\.yaml/);
});

test("a zero-token model row (Claude Code's <synthetic> turns) does not warn", async () => {
  const t = tally("<synthetic>");
  t.reduction.byModel.set("<synthetic>", { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
  const reporter = collectingReporter();
  await withPricing(null, () => withReporter(reporter, () => rollUpUsage("ws", [t])));
  assert.doesNotMatch(reporter.text(), /synthetic/);
});

// SW-836: the seed holds no rows, so a built-in price change reaches a machine seeded earlier.
test("the seeded file has no active model rows, and an uncommented example row parses", () => {
  const rows = parse(DEFAULT_MODEL_PRICING_YAML).models;
  assert.ok(!rows || Object.keys(rows).length === 0, JSON.stringify(rows));
  const example = DEFAULT_MODEL_PRICING_YAML.match(/^ {2}# (claude-[\w-]+: \{.*\})$/m);
  assert.ok(example, "seed lacks a commented example row");
  assert.ok(parse(`models:\n  ${example[1]}\n`).models);
});

for (const model of [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
]) {
  test(`${model} costs the same under the seeded file as under the built-ins`, async () => {
    const builtIn = await withPricing(null, () => rollUpUsage("ws", [tally(model)]));
    const seeded = await withPricing(DEFAULT_MODEL_PRICING_YAML, () =>
      rollUpUsage("ws", [tally(model)]),
    );
    assert.ok(seeded.estUsd > 0, `estUsd for ${model}: ${seeded.estUsd}`);
    assert.equal(seeded.estUsd, builtIn.estUsd);
  });
}

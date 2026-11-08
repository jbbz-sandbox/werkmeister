// SW-577: tier → model by harness, the person's `models:` merged over the built-ins one tier at a time.

import assert from "node:assert/strict";
import { test } from "node:test";

import { modelTiers, resolveModel } from "./dist/model_tiers.js";

const NONE = {};

test("built-ins: each claude tier, and blank is the default tier", () => {
  const got = ["small", "mid", "frontier", "advanced_frontier"].map(
    (t) => resolveModel(t, "claude", NONE).model,
  );
  assert.deepEqual(got, ["haiku", "sonnet", "opus", "claude-fable-5-1"]);
  assert.deepEqual(resolveModel("", "claude", NONE), { model: "opus", tier: "frontier" });
  assert.deepEqual(resolveModel(null, "opencode", NONE), {
    model: "anthropic/claude-opus-5-5",
    tier: "frontier",
  });
});

test("the person's block merges one tier at a time; default_tier picks the blank tier", () => {
  const cfg = { models: { default_tier: "mid", claude: { mid: "claude-sonnet-5-5" } } };
  assert.equal(resolveModel("mid", "claude", cfg).model, "claude-sonnet-5-5");
  assert.equal(resolveModel("small", "claude", cfg).model, "haiku");
  assert.deepEqual(resolveModel(undefined, "claude", cfg), {
    model: "claude-sonnet-5-5",
    tier: "mid",
  });
  const tiers = modelTiers(cfg);
  assert.equal(tiers.defaultOrigin, "YAML");
  assert.deepEqual(tiers.byHarness.claude.mid, { model: "claude-sonnet-5-5", origin: "YAML" });
  assert.deepEqual(tiers.byHarness.claude.small, { model: "haiku", origin: "default" });
});

test("an explicit model passes through trimmed; mcp is never resolved", () => {
  assert.deepEqual(resolveModel(" claude-opus-5-5 ", "claude", NONE), {
    model: "claude-opus-5-5",
    tier: null,
  });
  assert.deepEqual(resolveModel("", "mcp", NONE), { model: null, tier: null });
  assert.deepEqual(resolveModel("mid", "mcp", NONE), { model: "mid", tier: null });
});

test("codex has no built-ins: a tier fails naming the key, until the config sets it", () => {
  assert.throws(() => resolveModel("", "codex", NONE), /set models\.codex\.frontier/);
  assert.equal(resolveModel("", "codex", { models: { codex: { frontier: "o-x" } } }).model, "o-x");
});

test("a bad default_tier throws; a models: that is not a map, or a non-string value, uses the built-ins", () => {
  assert.throws(
    () => modelTiers({ models: { default_tier: "huge" } }),
    /models\.default_tier must be one of/,
  );
  assert.equal(resolveModel("", "claude", { models: "x" }).model, "opus");
  assert.equal(resolveModel("mid", "claude", { models: { claude: { mid: 3 } } }).model, "sonnet");
});

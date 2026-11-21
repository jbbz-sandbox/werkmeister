// Smoke test for the werkmeister-core usage reducer + cost math.
//   npm run build && node harness-claude-usage.smoke.mjs
import assert from "node:assert";
import path from "node:path";

const { reduceUsageLines, estimateUsd, rateFor } = await import("werkmeister-core");

const line = (model, u) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, usage: u } }) + "\n";

// Two opus turns + one unknown-model turn, plus a non-assistant line to skip.
const text =
  line("claude-opus-4-8", {
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 400,
  }) +
  line("claude-opus-4-8", {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
  }) +
  '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
  line("mystery-model", { input_tokens: 1, output_tokens: 2 });

const byModel = reduceUsageLines(text);

// Per-model accumulation, top-level fields only.
const opus = byModel.get("claude-opus-4-8");
assert.deepStrictEqual(opus, { input: 110, output: 220, cacheCreation: 330, cacheRead: 440 });
const mystery = byModel.get("mystery-model");
assert.deepStrictEqual(mystery, { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 });

// Cost math: 110/1e6*15 + 220/1e6*75 + 330/1e6*18.75 + 440/1e6*1.5
const rate = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
const expected = 110e-6 * 15 + 220e-6 * 75 + 330e-6 * 18.75 + 440e-6 * 1.5;
assert.ok(Math.abs(estimateUsd(opus, rate) - expected) < 1e-12, "opus cost");

// Unknown rate → null, never a guess.
assert.strictEqual(estimateUsd(mystery, undefined), null);

// Dated model id (e.g. Claude Code's "claude-haiku-4-5-20251001") resolves to
// the base id's rate; a truly unknown model still resolves to undefined.
const haikuPrices = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const haikuTotals = { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 };
const datedRate = rateFor(haikuPrices, "claude-haiku-4-5-20251001");
const baseRate = rateFor(haikuPrices, "claude-haiku-4-5");
assert.deepStrictEqual(datedRate, baseRate, "dated id should resolve to base rate");
const datedUsd = estimateUsd(haikuTotals, datedRate);
assert.ok(
  datedUsd != null && datedUsd === estimateUsd(haikuTotals, baseRate),
  "dated id cost matches base id cost",
);
assert.strictEqual(
  rateFor(haikuPrices, "made-up-model"),
  undefined,
  "unknown model stays undefined",
);

// Active time (SW-784): gaps under 5 min count, a long gap and an exactly-5-min gap don't.
const { reduceSession } = await import("werkmeister-core");
// Zero-token assistant turns: the sessions get rows without changing the totals below.
const at = (hhmm) =>
  JSON.stringify({
    type: "assistant",
    timestamp: `2026-11-20T${hhmm}:00.000Z`,
    message: { model: "claude-opus-4-8", usage: {} },
  }) + "\n";
const ms = (hhmm) => Date.parse(`2026-11-20T${hhmm}:00.000Z`);
const gappy = at("10:00") + at("10:02") + at("10:04") + at("10:30") + at("10:31") + at("10:36");
assert.deepStrictEqual(reduceSession(gappy).activeSpans, [
  [ms("10:00"), ms("10:04")],
  [ms("10:30"), ms("10:31")],
  [ms("10:36"), ms("10:36")],
]);
// A line with no timestamp leaves the spans alone.
assert.deepStrictEqual(reduceSession(text).activeSpans, []);

// --- getWorkspaceUsage end-to-end over a fabricated workspace + pricing file ---
import fs from "node:fs";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
const home = path.join(tmp, "home");
const wsRoot = path.join(tmp, "workspaces");
const wsPath = path.join(wsRoot, "demo");
fs.mkdirSync(wsPath, { recursive: true });
process.env.HOME = home;
process.env.WERKMEISTER_WORKSPACES_ROOT = wsRoot;

const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = path.join(home, ".claude", "projects", encoded);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(
  path.join(projDir, "sess1.jsonl"),
  line("claude-opus-4-8", {
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }),
);
// Two sessions: 10:00-10:04 + 10:30-10:31 (5 min), and 10:03-10:08 (5 min) overlapping the first.
fs.writeFileSync(path.join(projDir, "sess2.jsonl"), gappy);
fs.writeFileSync(path.join(projDir, "sess3.jsonl"), at("10:03") + at("10:07") + at("10:08"));

const pricingPath = path.join(tmp, "model-pricing.yaml");
fs.writeFileSync(
  pricingPath,
  "models:\n  claude-opus-4-8: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }\n",
);
process.env.WERKMEISTER_MODEL_PRICING_YAML = pricingPath;

const { getWorkspaceUsage } = await import("werkmeister-core");
const ws = await getWorkspaceUsage("demo");
assert.strictEqual(ws.byModel.length, 1);
assert.strictEqual(ws.byModel[0].model, "claude-opus-4-8");
assert.deepStrictEqual(ws.totals, { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 });
assert.ok(Math.abs(ws.estUsd - (100e-6 * 15 + 200e-6 * 75)) < 1e-12, "ws estUsd");
assert.strictEqual(ws.sessions.length, 3);
const active = Object.fromEntries(ws.sessions.map((s) => [s.sessionId, s.activeMinutes]));
// sess1's line has no timestamp: unmeasured, so null rather than 0.
assert.deepStrictEqual(active, { sess1: null, sess2: 5, sess3: 5 });
// Union: 10:00-10:08 + 10:30-10:31 = 9 min, not the 10 a per-session sum gives.
assert.strictEqual(ws.activeMinutes, 9);

console.log("harness-claude-usage.smoke OK");

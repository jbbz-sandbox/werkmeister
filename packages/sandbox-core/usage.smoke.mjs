// Smoke test for the sandbox-core usage reducer + cost math.
//   npm run build && node lib/usage.smoke.mjs
import assert from "node:assert";
import path from "node:path";
const { reduceUsageLines, estimateUsd, rateFor } = await import("sandbox-core");

const line = (model, u) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, usage: u } }) + "\n";

// Two opus turns + one unknown-model turn, plus a non-assistant line to skip.
const text =
  line("claude-opus-4-8", { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 }) +
  line("claude-opus-4-8", { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }) +
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
const haikuPrices = { "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } };
const haikuTotals = { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 };
const datedRate = rateFor(haikuPrices, "claude-haiku-4-5-20251001");
const baseRate = rateFor(haikuPrices, "claude-haiku-4-5");
assert.deepStrictEqual(datedRate, baseRate, "dated id should resolve to base rate");
const datedUsd = estimateUsd(haikuTotals, datedRate);
assert.ok(datedUsd != null && datedUsd === estimateUsd(haikuTotals, baseRate), "dated id cost matches base id cost");
assert.strictEqual(rateFor(haikuPrices, "made-up-model"), undefined, "unknown model stays undefined");

// --- getWorkspaceUsage end-to-end over a fabricated workspace + pricing file ---
import fs from "node:fs";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
const home = path.join(tmp, "home");
const wsRoot = path.join(tmp, "workspaces");
const wsPath = path.join(wsRoot, "demo");
fs.mkdirSync(wsPath, { recursive: true });
process.env.HOME = home;
process.env.SANDBOX_WORKSPACES_ROOT = wsRoot;

const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = path.join(home, ".claude", "projects", encoded);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "sess1.jsonl"),
  line("claude-opus-4-8", { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));

const pricingPath = path.join(tmp, "model-pricing.yaml");
fs.writeFileSync(pricingPath, "models:\n  claude-opus-4-8: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }\n");
process.env.SANDBOX_MODEL_PRICING_YAML = pricingPath;

const { getWorkspaceUsage } = await import("sandbox-core");
const ws = await getWorkspaceUsage("demo");
assert.strictEqual(ws.byModel.length, 1);
assert.strictEqual(ws.byModel[0].model, "claude-opus-4-8");
assert.deepStrictEqual(ws.totals, { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 });
assert.ok(Math.abs(ws.estUsd - (100e-6 * 15 + 200e-6 * 75)) < 1e-12, "ws estUsd");
assert.strictEqual(ws.sessions.length, 1);

console.log("usage.smoke OK");

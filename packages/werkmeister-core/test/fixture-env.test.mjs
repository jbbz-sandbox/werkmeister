// SW-918: seedFixture blanks the caller's variables from a hand-kept list, so each new binary or path
// resolver variable leaked until a review found it (OPENCODE_BIN, WERKMEISTER_CACHE_FILE in SW-911).
// This finds them in the source instead: a new one fails here until the fixture sets it or it is exempted.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { seedFixture } from "../dist/fixture_workspace.js";

// Core and the CLI it bundles: a fixture step runs both (SW-918 review: apps/cli read CLAUDE_PROJECT_DIR).
const SRCS = ["../src", "../../../apps/cli/src"].map((d) => path.resolve(import.meta.dirname, d));

/** Read on purpose with the caller's value, each with why that can't reach a real service, repo or HOME. */
const EXEMPT = {
  WERKMEISTER_ROOT:
    "the fixture runner sets it to this build's own root (internal fixture, pinWerkmeisterRoot)",
  WERKMEISTER_TEMP_HOME:
    "named in the probe guidance text only, never read by src; with-temp-home sets it (SW-1049)",
  WERKMEISTER_TELEPRESENCE_BIN:
    "read only under a test runner, the stub a test names; unset, telepresence is refused (SW-1153)",
};

/** Every binary or path variable a src module reads: process.env.X, process.env["X"], envVar("X"), registryPath(…, "X", …). */
function resolverVars() {
  const vars = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.includes(`${path.sep}__tests__${path.sep}`)) {
        const src = fs.readFileSync(p, "utf8");
        for (const [, a, b] of src.matchAll(
          /process\.env(?:\.([A-Z][A-Z0-9_]*)|\["([A-Z][A-Z0-9_]*)"\])/g,
        ))
          vars.add(a ?? b);
        for (const [, v] of src.matchAll(
          /(?:envVar|registryPath)\((?:"[a-z_]+", )?"([A-Z][A-Z0-9_]*)"/g,
        ))
          vars.add(`WERKMEISTER_${v}`);
      }
    }
  };
  for (const d of SRCS) walk(d);
  return [...vars].filter((v) => /_(BIN|FILE|YAML|ROOT|HOME|DIR)$/.test(v)).sort();
}

test("every binary or path variable src reads is set by the fixture, never the caller's (SW-918)", () => {
  const vars = resolverVars();
  // The scan must see the ones SW-911 blanked by hand, or it proves nothing.
  for (const known of [
    "OPENCODE_BIN",
    "CLAUDE_BIN",
    "WERKMEISTER_CACHE_FILE",
    "WERKMEISTER_SERVICES_YAML",
  ])
    assert.ok(vars.includes(known), `scan missed ${known}`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixture-env-")));
  try {
    const fx = seedFixture(root, { bare: true });
    // The caller's value, a distinct marker each, under the fixture's env as internal fixture merges them.
    const caller = Object.fromEntries(vars.map((v) => [v, `/caller/${v}`]));
    const env = { ...caller, ...fx.env };
    const leaked = vars.filter((v) => env[v] === caller[v] && !(v in EXEMPT));
    assert.deepEqual(leaked, [], "set each in seedFixture's env, or add it to EXEMPT with why");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

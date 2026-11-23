// SW-1063: CI's core jobs (core-test, node-floor) build werkmeister-core only, while the gate's
// werkmeister-core row builds the CLI first (its lint chain runs `turbo run build --filter=werkmeister`).
// So a core test that read another package's build passed the gate and failed CI with
// `Cannot find module …/apps/cli/dist/main.js`. This fails it in both, before CI.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const TEST_DIR = import.meta.dirname;

/** Another workspace package's dist, as a slash path or as path segments from the checkout. */
const OTHER_DIST = [
  /\b(?:apps|packages)\/(?!werkmeister-core\/)[\w.-]+\/dist\b/,
  /\(\s*(?:import\.meta\.dirname|REPO|monorepoRoot\(\))(?:,\s*"\.\.")*,\s*"(?:apps|packages)",\s*"(?!werkmeister-core")[\w.-]+",\s*"dist"/,
  /\(\s*(?:CLI_ROOT|sandboxRoot\(\)),\s*"dist"/,
];

/** `file:line: text` for each line of *text* where a call (or a line) reaches another package's build. */
function otherBuildRefs(file, text) {
  const lines = text.split("\n");
  const hits = new Set();
  for (const re of OTHER_DIST)
    for (const m of text.matchAll(new RegExp(re.source, "g")))
      hits.add(text.slice(0, m.index).split("\n").length); // `\s*` spans lines; the match starts at the call's `(`
  return [...hits].sort((a, b) => a - b).map((n) => `${file}:${n}: ${lines[n - 1].trim()}`);
}

test("the scan catches each way a core test names another package's build (SW-1063)", () => {
  const caught = [
    'execFile("node", ["../../apps/cli/dist/main.js", "budget", "status"])',
    'const cli = "/app/apps/cli/dist/main.js";',
    'path.resolve(import.meta.dirname, "..", "..", "..", "apps", "cli", "dist", "main.js")',
    'path.join(REPO, "apps", "werkmeister-mcp", "dist", "main.js")',
    'path.join(CLI_ROOT, "dist", "main.js")',
    'path.join(sandboxRoot(), "dist", "main.js")',
  ];
  for (const line of caught) assert.equal(otherBuildRefs("x", line).length, 1, line);
  // biome splits a long call over lines (SW-1102): reported at the line the call starts
  const split = [
    "const a = 1;",
    "const cli = path.resolve(",
    "  import.meta.dirname,",
    '  "..",',
    '  "apps",',
    '  "cli",',
    '  "dist",',
    '  "main.js",',
    ");",
  ].join("\n");
  assert.deepEqual(otherBuildRefs("x", split), ["x:2: const cli = path.resolve("]);
  const passed = [
    'await import("../dist/config.js")', // core's own build: CI builds it
    'path.join(wt, "apps", "cli", "dist", "main.js")', // a fake CLI in a temp folder (SW-548)
    'path.resolve(import.meta.dirname, "../../../apps/cli/infra/compose/shared-infra.yml")', // source, not a build
    'path.join(REPO, "packages", "werkmeister-core", "dist")',
  ];
  for (const line of passed) assert.deepEqual(otherBuildRefs("x", line), [], line);
});

test("no core test reads another package's build: CI's core jobs build werkmeister-core only (SW-1063)", () => {
  const refs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:mjs|js|cjs|ts|sh)$/.test(e.name) && p !== import.meta.filename)
        refs.push(...otherBuildRefs(path.relative(TEST_DIR, p), fs.readFileSync(p, "utf8")));
    }
  };
  walk(TEST_DIR);
  assert.deepEqual(
    refs,
    [],
    "build what the test needs in-process from core's dist, or move it to the package that builds it",
  );
});

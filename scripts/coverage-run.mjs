#!/usr/bin/env node
/**
 * One package's `test:coverage` (SW-405): runs its test command under c8 (or as is with --no-c8,
 * where vitest measures itself), passes the output through, and writes coverage/run.json with the
 * test count and wall time beside the istanbul reports, for `coverage-summary.mjs` and the ledger.
 *
 *   node ../../scripts/coverage-run.mjs [--no-c8] -- <test command…>
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tests, build output and generated code are not the source under test (D8).
const EXCLUDE = [
  "dist/**",
  "out/**",
  "**/*.test.*",
  "test/**",
  "bdd/**",
  "**/fixtures/**",
  "sdk/**",
  ".vitepress/cache/**",
  "**/node_modules/**",
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes a forced-colour CI run adds
const ANSI = /\x1b\[[0-9;]*m/g;

/** Tests the run reported: node's TAP or spec summary (one per `node --test` run, summed) or vitest's. Null when none. */
export function countTests(text) {
  const plain = text.replace(ANSI, "");
  let n = null;
  // Anchored on the `suites` line that follows, so a test that logs "# tests 3" isn't counted.
  for (const m of plain.matchAll(/^(?:#|ℹ) tests (\d+)\r?\n(?:#|ℹ) suites /gm))
    n = (n ?? 0) + Number(m[1]);
  for (const m of plain.matchAll(/^\s*Tests\s+.*\((\d+)\)/gm)) n = (n ?? 0) + Number(m[1]);
  return n;
}

/** Failed tests the run reported, in the same summaries as {@link countTests} (SW-1101). Null when none. */
export function countFailures(text) {
  const plain = text.replace(ANSI, "");
  let n = null;
  // node prints `# fail N` after `# pass`, just before `# cancelled`; anchored on it as countTests is on `suites`.
  for (const m of plain.matchAll(/^(?:#|ℹ) fail (\d+)\r?\n(?:#|ℹ) cancelled /gm))
    n = (n ?? 0) + Number(m[1]);
  for (const m of plain.matchAll(/^\s*Tests\s+(?:(\d+) failed\b)?.*\(\d+\)/gm))
    n = (n ?? 0) + Number(m[1] ?? 0);
  return n;
}

function c8Command(cmd, temp) {
  const c8 = createRequire(import.meta.url).resolve("c8/bin/c8.js");
  // Without --exclude-after-remap, `-x dist/**` drops every file: it matches before the map points at src/ (c8 11).
  const reports = ["json-summary", "lcov", "html"].flatMap((r) => ["-r", r]);
  return [
    process.execPath,
    c8,
    "--exclude-after-remap",
    ...reports,
    "--reports-dir",
    "coverage",
    // c8's default, coverage/tmp, keeps V8's raw dumps beside the report: 273 MB for core.
    "--temp-directory",
    temp,
  ].concat(
    EXCLUDE.flatMap((g) => ["-x", g]),
    cmd,
  );
}

async function main(argv) {
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) {
    console.error("usage: coverage-run.mjs [--no-c8] -- <test command…>");
    return 2;
  }
  const cmd = argv.slice(sep + 1);
  const temp = mkdtempSync(join(tmpdir(), "coverage-run-"));
  const [bin, ...args] = argv.slice(0, sep).includes("--no-c8") ? cmd : c8Command(cmd, temp);
  const started = Date.now();
  const child = spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"] });
  const chunks = [];
  for (const [from, to] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    from.on("data", (d) => {
      to.write(d);
      chunks.push(d);
    });
  }
  const code = await new Promise((done) => {
    child.on("error", (e) => {
      console.error(`coverage-run: ${e.message}`);
      done(127);
    });
    child.on("close", (c) => done(c ?? 1));
  });
  rmSync(temp, { recursive: true, force: true });
  // Written on failure too, so a red run still gets its row.
  mkdirSync("coverage", { recursive: true });
  const out = Buffer.concat(chunks).toString("utf8");
  const run = {
    tests: countTests(out),
    failures: countFailures(out),
    duration_ms: Date.now() - started,
  };
  writeFileSync("coverage/run.json", `${JSON.stringify(run)}\n`);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));

// SW-826: run-tests.sh runs the files in shared-process.list in one process (SW-802). The list was
// audited once; this keeps it true: a listed file that goes missing, or starts touching shared state,
// fails here with its name, instead of as a flaky test in some other file.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const pkg = path.join(import.meta.dirname, "..");

// SW-802's audit patterns: each one leaks into the files that share the process.
export const SHARED_STATE = [
  [
    "writes process.env",
    /process\.env(\.\w+|\[[^\]]+\])\s*=(?!=)|delete\s+process\.env|Object\.assign\(\s*process\.env/,
  ],
  ["changes cwd", /process\.chdir\(/],
  ["writes a global", /globalThis(\.\w+|\[[^\]]+\])\s*=(?!=)/],
  ["sets process.exitCode or argv", /process\.(exitCode|argv)\s*=(?!=)/],
  ["listens on or exits the process", /process\.(on|once|exit)\(/],
  [
    "reassigns stdout, stderr or console",
    /process\.(stdout|stderr)\.write\s*=(?!=)|console\.\w+\s*=(?!=)/,
  ],
  ["mocks", /\bmock\b/],
  [
    "calls an env-setting fixtures.mjs helper",
    /\b(pinWerkmeisterRoot|useDockerEngine|withSandboxHome|withFakeGh|withFixtureWorkspace|withFakeDaemon)\b/,
  ],
  ["reaches daemon_client or scheduler_client", /\b(daemon_client|scheduler_client)\b/],
  ["has a top-level hook", /^(before|after|beforeEach|afterEach)\(/m],
];

/** The first audit rule *text* breaks, as "<what> (<match>)", or null. */
export function sharedStateIn(text) {
  for (const [what, re] of SHARED_STATE) {
    const m = re.exec(text);
    if (m) return `${what} (${m[0].trim()})`;
  }
  return null;
}

const listed = fs
  .readFileSync(path.join(pkg, "test", "shared-process.list"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

test("every file in shared-process.list exists and leaves shared state alone (SW-826)", () => {
  const bad = [];
  for (const f of listed) {
    const file = path.join(pkg, f);
    if (!fs.existsSync(file)) {
      bad.push(`${f}: missing, so it runs isolated; remove it from the list`);
      continue;
    }
    const why = sharedStateIn(fs.readFileSync(file, "utf8"));
    if (why) bad.push(`${f}: ${why}; remove it from shared-process.list, or fix the file`);
  }
  assert.deepEqual(bad, []);
});

test("each audit rule catches its leak (SW-826)", () => {
  for (const leak of [
    'process.env.X = "1";',
    "delete process.env.HOME;",
    'process.chdir("/");',
    "globalThis.fetch = f;",
    "process.exitCode = 1;",
    'process.on("exit", f);',
    "console.log = f;",
    "mock.method(fs, 'readFileSync');",
    "await withSandboxHome(() => {});",
    'import "../dist/daemon_client.js";',
    "beforeEach(() => {});",
    "after(() => {});",
  ])
    assert.ok(sharedStateIn(leak), leak);
  for (const fine of [
    'assert.equal(process.env.X, "1");',
    "  before(() => {});",
    "if (process.exitCode === 1) {}",
  ])
    assert.equal(sharedStateIn(fine), null, fine);
});

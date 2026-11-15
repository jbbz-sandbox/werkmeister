// SW-655: the Workspaces pane loads only `werkmeister-core/sdk`, so every core call in its
// node-child script must be on that entry, and none may reach past it into dist/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";

const sdk = await import("werkmeister-core/sdk");
const register = fs.readFileSync(
  new URL("../../../plugins/werkmeister/hooks/register.tsx", import.meta.url),
  "utf8",
);
const script = register.slice(register.indexOf("const SCRIPT = `"), register.indexOf("\n`;\n"));

test("every core.<fn> the pane script calls is a function on werkmeister-core/sdk", () => {
  const called = [...new Set([...script.matchAll(/\bcore\.(\w+)\(/g)].map((m) => m[1]))];
  assert.ok(called.length > 20, `found only ${called.length} core calls; did SCRIPT move?`);
  const missing = called.filter((name) => typeof sdk[name] !== "function");
  assert.deepEqual(missing, []);
});

// SW-748: the bare `up` read like the workspace verb; the infra lifecycle is named for what it starts.
test("the shared-infra lifecycle is infra*, and the bare up is gone", () => {
  for (const name of [
    "infraUp",
    "infraDown",
    "infraStop",
    "infraRestart",
    "infraHealth",
    "connectK8s",
  ])
    assert.equal(typeof sdk[name], "function", name);
  assert.equal(sdk.up, undefined);
  // Connect calls `(core.infraUp ?? core.up)()`, which test 1's `core.<fn>(` scan can't see.
  assert.match(script, /\bcore\.infraUp\b/);
  assert.deepEqual(sdk.WORKSPACE_ACTIONS, ["up", "stop", "restart", "down", "pause", "resume"]);
});

test("the pane script imports no core file by path", () => {
  assert.doesNotMatch(script, /dist\/|\.js['"]\)|resolve\('werkmeister-core'\)/);
});

test("the pane script finds werkmeister-core/sdk from WERKMEISTER_CORE_PATH and loads it", async () => {
  // SCRIPT's only template escapes are \\ and \` (no interpolation): undo them to get what node runs.
  const code = script.slice("const SCRIPT = `".length).replace(/\\([\\`])/g, "$1");
  const child = spawn("node", ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      WERKMEISTER_CORE_PATH: new URL("../dist/sandbox.js", import.meta.url).pathname,
    },
  });
  child.stdin.end(JSON.stringify({ op: "nope" }));
  let out = "";
  for await (const c of child.stdout) out += c;
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), {
    ok: false,
    error: "unknown op nope",
  });
});

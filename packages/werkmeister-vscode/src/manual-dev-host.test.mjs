// SW-1020: the fixture dev host's daemon serves only the fixture, and its CLI is a stub that logs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { prepare, startFixtureDaemon } from "../scripts/manual-dev-host.mjs";
import { snapshot } from "../scripts/snapshot-fixture.mjs";

const tool = (url, name) =>
  fetch(`${url}/api/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: {} }),
  });

test("the fixture daemon answers status, resources and intercepts from the fixture, 501s the rest, and logs each", async (t) => {
  const d = await startFixtureDaemon("busy");
  t.after(() => d.close());
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = await (await tool(d.url, "status")).json();
  assert.deepEqual(status.structuredContent.statuses, snapshot("busy").statuses);
  assert.equal((await tool(d.url, "resources")).status, 200);
  assert.equal((await tool(d.url, "intercepts")).status, 200);
  for (const name of ["down", "close-out", "stop"])
    assert.equal((await tool(d.url, name)).status, 501);
  assert.equal(d.calls.length, 6);
  assert.match(d.calls.at(-1), /"name":"stop"/);
});

test("prepare: temp HOME, workspaces root and VS Code dirs, a folder per row, and CLI stubs that only log", (t) => {
  // The caller's shell exports these (~/.werkmeister/env.sh); none may reach the window (SW-1020 review).
  const inherited = {
    WERKMEISTER_WORKSPACES_ROOT: "/real/features",
    WERKMEISTER_CONFIG_FILE: "/real/.werkmeister/config.yaml",
    WERKMEISTER_ROOT: "/real/werkmeister/apps/cli",
    WERKMEISTER_MCP_TOKEN: "real-token",
  };
  const saved = Object.fromEntries(Object.keys(inherited).map((k) => [k, process.env[k]]));
  Object.assign(process.env, inherited);
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const run = prepare("quiet", "http://127.0.0.1:1");
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  assert.ok(run.root.startsWith(tmpdir()), run.root);
  for (const k of ["HOME", "WERKMEISTER_WORKSPACES_ROOT", "WERKMEISTER_BIN"])
    assert.ok(run.env[k].startsWith(run.root), `${k} is under the temp folder`);
  assert.equal(run.env.WERKMEISTER_HOST, "http://127.0.0.1:1");
  assert.equal(run.env.WERKMEISTER_FIXTURE, "1");
  for (const k of ["WERKMEISTER_CONFIG_FILE", "WERKMEISTER_ROOT", "WERKMEISTER_MCP_TOKEN"])
    assert.equal(run.env[k], undefined, `${k} is not inherited`);
  assert.deepEqual(
    readdirSync(run.env.WERKMEISTER_WORKSPACES_ROOT).sort(),
    snapshot("quiet")
      .statuses.map((w) => w.name)
      .sort(),
  );
  execFileSync(run.env.WERKMEISTER_BIN, ["feature", "down", "sw-101-login"]);
  assert.equal(readFileSync(run.log, "utf8"), "werkmeister feature down sw-101-login\n");
});

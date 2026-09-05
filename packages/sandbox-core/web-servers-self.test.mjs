// `sandbox connect` runs as a tool ON the MCP server, and infra.up() calls
// startAll(). Without the guard below, a stale dist/ makes start() SIGTERM the
// pid in the file -- which is the process serving the request.
//
// Hermetic: os.homedir() honours $HOME on POSIX, so the whole PID-file state
// dir moves to a tmpdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { ALL, CLAUDECK, DASHBOARD, MCP, start } from "./dist/web_servers.js";

test("MCP is one of the servers `sandbox connect` brings up, on its own stem", () => {
  assert.ok(ALL.includes(MCP));
  assert.equal(MCP.port, 3002);
  // DASHBOARD already holds "mcp-server"; a collision would make the two apps
  // share a PID file and reap each other.
  assert.notEqual(MCP.stem, DASHBOARD.stem);
  assert.equal(MCP.stem, "sandbox-mcp");
});

test("only MCP binds wide -- DASHBOARD and CLAUDECK stay loopback-only", () => {
  // A container has no loopback route to the host, so apps/mcp must bind
  // 0.0.0.0. DASHBOARD/CLAUDECK are unauthenticated and must never inherit
  // that env var, or their tools become reachable from the network.
  assert.deepEqual(MCP.env, { HOST: "0.0.0.0" });
  assert.equal(DASHBOARD.env?.HOST, undefined);
  assert.equal(CLAUDECK.env?.HOST, undefined);
});

test("start() leaves a server alone when the PID file is this very process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "web-servers-self-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const pidFile = path.join(home, ".sandbox", `${MCP.stem}.pid`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  try {
    const reporter = collectingReporter();
    const ok = await withReporter(reporter, () => start(MCP));
    assert.equal(ok, true);
    assert.match(reporter.text(), /this process/);
    // Nothing was stopped, so nothing removed the file.
    assert.equal(fs.readFileSync(pidFile, "utf8"), String(process.pid));
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

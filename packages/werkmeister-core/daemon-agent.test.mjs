// SW-184: on macOS `werkmeister setup` hands the daemon to launchd (KeepAlive),
// and from then on the PID-file start/stop in web_servers.ts leaves it alone.
// launchctl is the injected runner; nothing here reaches the real launchd.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const { daemonPlist, syncDaemonAgent } = await import("./dist/machine_setup.js");
const { DAEMON_LABEL, daemonPlistPath, MCP, stop } = await import("./dist/web_servers.js");

let home;
let calls;
let stopped;
const prevHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-agent-"));
  process.env.HOME = home;
  calls = [];
  stopped = 0;
});
afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const opts = (extra = {}) => ({
  platform: "darwin",
  home,
  node: "/opt/node/bin/node",
  entry: { dir: "/opt/werkmeister/apps/werkmeister-mcp", entry: "dist/main.js" },
  pathEnv: "/usr/local/bin:/usr/bin",
  port: 3002,
  logFile: path.join(home, "daemon.log"),
  uid: 501,
  runner: (argv) => {
    calls.push(argv.join(" "));
    return [0, ""];
  },
  stopPidServer: async () => {
    stopped++;
  },
  ...extra,
});

test("the plist keeps the daemon alive with the node, entry, PATH, port and wide bind baked in", () => {
  const plist = daemonPlist(opts());
  for (const want of [
    `<string>${DAEMON_LABEL}</string>`,
    "<string>/opt/node/bin/node</string>",
    "<string>dist/main.js</string>",
    "<string>/opt/werkmeister/apps/werkmeister-mcp</string>",
    "<key>KeepAlive</key>\n  <true/>",
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>PORT</key>\n    <string>3002</string>",
    "<key>HOST</key>\n    <string>0.0.0.0</string>",
    "<string>/usr/local/bin:/usr/bin</string>",
  ]) {
    assert.ok(plist.includes(want), `plist lacks ${want}`);
  }
});

test("setup installs it once: stops the PID-file server, writes the plist, bootstraps", async () => {
  const [step] = await syncDaemonAgent(false, true, opts());
  assert.equal(step.ok, true, step.detail);
  assert.equal(stopped, 1);
  assert.equal(fs.readFileSync(daemonPlistPath(home), "utf8"), daemonPlist(opts()));
  assert.deepEqual(calls, [
    `launchctl bootout gui/501/${DAEMON_LABEL}`,
    `launchctl bootstrap gui/501 ${daemonPlistPath(home)}`,
  ]);

  calls = [];
  const [again] = await syncDaemonAgent(false, true, opts());
  assert.match(again.detail, /up to date/);
  assert.deepEqual(calls, []);
  assert.equal(stopped, 1);
});

test("--check reports without installing", async () => {
  const [step] = await syncDaemonAgent(true, true, opts());
  assert.equal(step.ok, false);
  assert.match(step.detail, /not installed/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(daemonPlistPath(home)), false);
});

test("without the wizard's yes it only reports, so a setup run never installs uninvited", async () => {
  const [step] = await syncDaemonAgent(false, false, opts());
  assert.match(step.detail, /not installed/);
  assert.equal(step.optional, true);
  assert.deepEqual(calls, []);
  assert.equal(stopped, 0);
});

test("off macOS the step only points at `werkmeister connect`", async () => {
  const [step] = await syncDaemonAgent(false, true, opts({ platform: "linux" }));
  assert.equal(step.ok, true);
  assert.match(step.detail, /werkmeister connect/);
  assert.deepEqual(calls, []);
});

test("once launchd owns the daemon, a PID-file stop leaves it running", {
  skip: process.platform !== "darwin",
}, async () => {
  fs.mkdirSync(path.dirname(daemonPlistPath(home)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(home), "<plist/>");
  assert.equal(await stop(MCP), false);
});

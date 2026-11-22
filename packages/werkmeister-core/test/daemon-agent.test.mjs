// SW-184: on macOS `werkmeister machine setup` hands the daemon to launchd (KeepAlive),
// and from then on the PID-file start/stop in web_servers.ts leaves it alone.
// launchctl is the injected runner; nothing here reaches the real launchd.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const { daemonPlist, syncDaemonAgent, uninstallDaemonAgent } = await import(
  "../dist/machine_setup.js"
);
const { DAEMON_LABEL, daemonPlistPath, MCP, stop } = await import("../dist/web_servers.js");

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
  serving: async () => true,
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
  // Loaded already: checked, not restarted.
  assert.deepEqual(calls, [`launchctl print gui/501/${DAEMON_LABEL}`]);
  assert.equal(stopped, 1);
});

test("daemon uninstall boots the agent out and removes the plist; again, it says none is installed", async () => {
  await syncDaemonAgent(false, true, opts());
  calls = [];
  const step = uninstallDaemonAgent(opts());
  assert.equal(step.ok, true);
  assert.deepEqual(calls, [`launchctl bootout gui/501/${DAEMON_LABEL}`]);
  assert.equal(fs.existsSync(daemonPlistPath(home)), false);
  assert.match(uninstallDaemonAgent(opts()).detail, /no launchd agent installed/);
});

// SW-236: bootout returns before launchd drops the label, so the first bootstrap
// can fail with 5; and a re-run with the plist already written must still load it.
const scripted = (replies) => (argv) => {
  const cmd = argv.join(" ");
  calls.push(cmd);
  const key = Object.keys(replies).find((k) => cmd.startsWith(k));
  return key ? (replies[key].length > 1 ? replies[key].shift() : replies[key][0]) : [0, ""];
};
const bootstrap = () => `launchctl bootstrap gui/501 ${daemonPlistPath(home)}`;

test("a changed plist survives bootstrap failing with 5 while the old label goes away", async () => {
  const runner = scripted({
    "launchctl bootstrap": [
      [5, "Bootstrap failed: 5: Input/output error"],
      [0, ""],
    ],
  });
  const [step] = await syncDaemonAgent(false, true, opts({ runner }));
  assert.equal(step.ok, true, step.detail);
  assert.deepEqual(calls.filter((c) => c.includes("bootstrap")).length, 2);
});

test("a bootstrap that keeps failing gives up after a bounded retry, and the re-run tries again", async () => {
  const runner = scripted({
    "launchctl bootstrap": [[5, "Bootstrap failed: 5: Input/output error"]],
    "launchctl print": [[113, "Could not find service"]],
  });
  const [step] = await syncDaemonAgent(false, true, opts({ runner }));
  assert.equal(step.ok, false);
  assert.match(step.detail, /Input\/output error.*re-run to retry/);
  assert.ok(calls.filter((c) => c.startsWith("launchctl bootstrap")).length <= 5);

  calls = [];
  const [again] = await syncDaemonAgent(false, true, opts({ runner }));
  assert.equal(again.ok, false);
  assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")));
});

test("an unchanged plist whose label is not loaded is bootstrapped", async () => {
  await syncDaemonAgent(false, true, opts());
  calls = [];
  const runner = scripted({ "launchctl print": [[113, "Could not find service"]] });
  const [step] = await syncDaemonAgent(false, true, opts({ runner }));
  assert.equal(step.ok, true, step.detail);
  assert.deepEqual(calls, [`launchctl print gui/501/${DAEMON_LABEL}`, bootstrap()]);
});

test("--check reports without installing", async () => {
  const [step] = await syncDaemonAgent(true, true, opts());
  assert.equal(step.ok, false);
  assert.match(step.detail, /not installed/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(daemonPlistPath(home)), false);
});

test("--check on an installed agent says whether the daemon answers (SW-614)", async () => {
  await syncDaemonAgent(false, true, opts());
  const [up] = await syncDaemonAgent(true, false, opts());
  assert.equal(up.ok, true);
  assert.match(up.detail, /: installed$/);
  const [down] = await syncDaemonAgent(true, false, opts({ serving: async () => false }));
  assert.equal(down.ok, false);
  assert.match(
    down.detail,
    /installed, but nothing answers at http:\/\/127\.0\.0\.1:3002: the daemon is not running/,
  );
});

test("without the wizard's yes it only reports, so a setup run never installs uninvited", async () => {
  const [step] = await syncDaemonAgent(false, false, opts());
  assert.match(step.detail, /not installed/);
  assert.equal(step.optional, true);
  assert.deepEqual(calls, []);
  assert.equal(stopped, 0);
});

test("--check off macOS reports a daemon that does not answer (SW-614)", async () => {
  const linux = (serving) => opts({ platform: "linux", serving: async () => serving });
  const [up] = await syncDaemonAgent(true, false, linux(true));
  assert.equal(up.ok, true);
  assert.match(up.detail, /not on macOS: `werkmeister infra connect` starts it/);
  const [down] = await syncDaemonAgent(true, false, linux(false));
  assert.equal(down.ok, false);
  assert.match(
    down.detail,
    /not on macOS and nothing answers at .*: the daemon is not running — run `werkmeister infra connect`/,
  );
});

test("off macOS the step only points at `werkmeister infra connect`", async () => {
  const [step] = await syncDaemonAgent(false, true, opts({ platform: "linux" }));
  assert.equal(step.ok, true);
  assert.match(step.detail, /werkmeister infra connect/);
  assert.deepEqual(calls, []);
});

test("once launchd owns the daemon, a PID-file stop leaves it running", {
  skip: process.platform !== "darwin",
}, async () => {
  fs.mkdirSync(path.dirname(daemonPlistPath(home)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(home), "<plist/>");
  assert.equal(await stop(MCP), false);
});

// SW-1054: launchctl acts on gui/<uid> whatever HOME is, so a temp HOME (with-temp-home) or a
// fixture run must never boot out, bootstrap or rewrite the login session's agents.
for (const [why, env] of [
  ["with-temp-home", () => ({ WERKMEISTER_TEMP_HOME: home })],
  ["a fixture run", () => ({ WERKMEISTER_FIXTURE: "1" })],
]) {
  test(`under ${why}, daemon install and uninstall never run launchctl (SW-1054)`, async (t) => {
    const set = env();
    const prev = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    t.after(() => {
      for (const [k, v] of Object.entries(prev))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });
    const [step] = await syncDaemonAgent(false, true, opts());
    assert.equal(step.ok, true);
    assert.match(step.detail, /skipped/);
    assert.equal(fs.existsSync(daemonPlistPath(home)), false, "no plist written");
    fs.mkdirSync(path.dirname(daemonPlistPath(home)), { recursive: true });
    fs.writeFileSync(daemonPlistPath(home), "<plist/>");
    assert.match(uninstallDaemonAgent(opts()).detail, /skipped/);
    assert.deepEqual(calls, []);
  });
}

test("sharedProxySkipReason: a with-temp-home HOME at the default config path leaves the shared Caddy alone (SW-1054)", async (t) => {
  const { sharedProxySkipReason } = await import("../dist/config.js");
  const prev = [process.env.WERKMEISTER_TEMP_HOME, process.env.WERKMEISTER_CONFIG_FILE];
  delete process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_TEMP_HOME = home;
  t.after(() => {
    for (const [k, v] of [
      ["WERKMEISTER_TEMP_HOME", prev[0]],
      ["WERKMEISTER_CONFIG_FILE", prev[1]],
    ])
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  assert.ok(sharedProxySkipReason(), "a temp HOME is not the machine's home");
  // HOME moved off the marker: the predicate is the marker, not any HOME override.
  process.env.WERKMEISTER_TEMP_HOME = path.join(home, "elsewhere");
  assert.equal(sharedProxySkipReason(), undefined);
  // The real home: no marker, the guard stays off.
  delete process.env.WERKMEISTER_TEMP_HOME;
  assert.equal(sharedProxySkipReason(), undefined);
});

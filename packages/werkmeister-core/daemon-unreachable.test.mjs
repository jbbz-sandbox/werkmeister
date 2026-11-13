// SW-614: why the daemon on 3002 refused or reset a call. The daemon exits and
// launchd starts it again on every build change (SW-306), so a CLI call can land
// in that gap; a call it accepted but answered late must not be run again here.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-unreachable-"));
let client;
before(async () => {
  process.env.HOME = home;
  process.env.WERKMEISTER_DAEMON_RETRY_MS = "3000";
  client = await import("./dist/daemon_client.js");
});
after(() => {
  delete process.env.WERKMEISTER_HOST;
  delete process.env.WERKMEISTER_DAEMON_RETRY_MS;
  fs.rmSync(home, { recursive: true, force: true });
});

const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
const freePort = async () => {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
};
const daemonOn = async (port) => {
  const s = http.createServer((req, res) => {
    req.resume();
    res.setHeader("connection", "close");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ structuredContent: { ok: true }, text: "" }));
  });
  await listen(s, port);
  return s;
};

test("a call during the daemon's restart gap waits for it instead of falling back", async () => {
  const port = await freePort();
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${port}`;
  // launchd brings the new build up ~1 s after the old one exited.
  const up = new Promise((r) => setTimeout(r, 1000)).then(() => daemonOn(port));
  try {
    const r = await client.callTool("scheduler", { op: "queue" }, { token: "t" });
    assert.deepEqual(r.data, { ok: true });
  } finally {
    (await up).close();
  }
});

test("a connection reset before any reply (the daemon exiting) is resent once it is back", async () => {
  let resets = 1;
  const flaky = await daemonOn(0);
  // RST on accept, as a connection queued on the exiting daemon's socket gets.
  flaky.on("connection", (socket) => resets-- > 0 && socket.resetAndDestroy());
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${flaky.address().port}`;
  try {
    const r = await client.callTool("scheduler", { op: "queue" }, { token: "t" });
    assert.deepEqual(r.data, { ok: true });
  } finally {
    flaky.close();
  }
});

test("nothing listening after the restart window: DaemonUnavailable says the daemon is not running", async () => {
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${await freePort()}`;
  await assert.rejects(client.callTool("scheduler", {}, { token: "t" }), (e) => {
    assert.ok(e instanceof client.DaemonUnavailable);
    assert.match(e.message, /not running/);
    return true;
  });
});

test("after one wait gave up, the next call in the process falls back at once", async () => {
  // Follows the test above, whose wait gave up: a down daemon must not cost every scheduler op 15 s.
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${await freePort()}`;
  const t0 = Date.now();
  await assert.rejects(client.callTool("scheduler", {}, { token: "t" }), client.DaemonUnavailable);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("the port held by something that is not the daemon: DaemonUnavailable names the port taken", async () => {
  const other = http.createServer((req, res) => (req.resume(), res.writeHead(404).end("nope")));
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${await listen(other)}`;
  try {
    await assert.rejects(client.callTool("scheduler", {}, { token: "t" }), (e) => {
      assert.ok(e instanceof client.DaemonUnavailable, `got ${e.name}: ${e.message}`);
      assert.match(e.message, /not the werkmeister daemon/);
      return true;
    });
  } finally {
    other.close();
  }
});

test("a call the daemon accepted but answered late is not DaemonUnavailable: the op may still run there", async () => {
  const slow = http.createServer(() => {});
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${await listen(slow)}`;
  try {
    await assert.rejects(
      client.callTool("scheduler", { op: "grant" }, { token: "t", timeoutMs: 200 }),
      (e) => {
        assert.ok(
          !(e instanceof client.DaemonUnavailable),
          "would run the grant a second time here",
        );
        assert.equal(e.code, "DAEMON_TIMEOUT");
        return true;
      },
    );
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

test("a connect that timed out never reached the daemon, so the caller may still fall back", () => {
  assert.equal(client.tookTheCall("UND_ERR_CONNECT_TIMEOUT"), false);
  for (const code of [
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "TimeoutError",
  ])
    assert.equal(client.tookTheCall(code), true, code);
  for (const code of ["ECONNREFUSED", "ECONNRESET", "AbortError", "TypeError"])
    assert.equal(client.tookTheCall(code), false, code);
});

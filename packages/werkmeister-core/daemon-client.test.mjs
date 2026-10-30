// SW-184: the thin-client side. A tiny node:http server stands in for the
// daemon, so fetch, the SSE parsing and the abort wiring are the real ones.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

const seen = [];
let openStreams = 0;
const daemon = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ url: req.url, auth: req.headers.authorization, body });
  if (req.url === "/api/tool") {
    const { name } = JSON.parse(body);
    res.writeHead(name === "boom" ? 400 : 200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify(
        name === "boom"
          ? { error: "it broke", code: "NOT_RUNNING" }
          : { structuredContent: { ok: name }, text: "done" },
      ),
    );
  }
  if (req.url.startsWith("/api/logs/stream")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify("line one\n")}\n\n`);
    res.write(`data: ${JSON.stringify("line\ntwo\n")}\n\n`);
    if (req.url.includes("service=done")) return res.end("event: end\ndata: \n\n");
    openStreams++;
    req.socket.once("close", () => openStreams--);
    return;
  }
  res.writeHead(404).end();
});

let client;
let home;
before(async () => {
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-client-"));
  process.env.HOME = home;
  process.env.WERKMEISTER_HOST = `http://127.0.0.1:${daemon.address().port}`;
  client = await import("./dist/daemon_client.js");
});
after(() => {
  delete process.env.WERKMEISTER_HOST;
  daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("daemonToken: env, then the workspace's own token, then the machine token", () => {
  const ws = path.join(home, "ws");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.mkdirSync(path.join(home, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(home, ".werkmeister", "mcp-token"), "machine\n");
  assert.equal(client.daemonToken(ws), "machine");
  fs.writeFileSync(path.join(ws, ".werkmeister", "token"), "workspace\n");
  assert.equal(client.daemonToken(ws), "workspace");
  assert.equal(client.daemonToken(), "machine");
  process.env.WERKMEISTER_MCP_TOKEN = "env";
  try {
    assert.equal(client.daemonToken(ws), "env");
  } finally {
    delete process.env.WERKMEISTER_MCP_TOKEN;
  }
});

test("daemonPort: WERKMEISTER_MCP_PORT, else 3002", () => {
  assert.equal(client.daemonPort(), 3002);
  process.env.WERKMEISTER_MCP_PORT = "4555";
  try {
    assert.equal(client.daemonPort(), 4555);
  } finally {
    delete process.env.WERKMEISTER_MCP_PORT;
  }
});

test("callTool posts the call with the bearer token and returns data and text", async () => {
  const r = await client.callTool("status", { detail: false }, { token: "t0k" });
  assert.deepEqual(r, { data: { ok: "status" }, text: "done" });
  const last = seen.at(-1);
  assert.equal(last.auth, "Bearer t0k");
  assert.deepEqual(JSON.parse(last.body), { name: "status", arguments: { detail: false } });
});

test("a tool error is a SandboxError with the daemon's code", async () => {
  await assert.rejects(client.callTool("boom", {}, { token: "t" }), {
    name: "SandboxError",
    code: "NOT_RUNNING",
    message: "it broke",
  });
});

test("a daemon that is not listening is DaemonUnavailable, so a caller can fall back", async () => {
  const prev = process.env.WERKMEISTER_HOST;
  process.env.WERKMEISTER_HOST = "http://127.0.0.1:1";
  try {
    await assert.rejects(client.callTool("status"), (e) => {
      assert.ok(e instanceof client.DaemonUnavailable);
      assert.equal(e.code, "DAEMON_DOWN");
      return true;
    });
  } finally {
    process.env.WERKMEISTER_HOST = prev;
  }
});

test("streamLogs delivers each SSE chunk whole, and settles on `event: end`", async () => {
  const chunks = [];
  const tail = client.streamLogs("ws", "done", (c) => chunks.push(c), { token: "t" });
  await tail.done;
  assert.deepEqual(chunks, ["line one\n", "line\ntwo\n"]);
  assert.match(seen.at(-1).url, /feature=ws&service=done/);
});

test("stop() closes the stream and settles done", async () => {
  const chunks = [];
  const tail = client.streamLogs("ws", null, (c) => chunks.push(c), { token: "t" });
  while (chunks.length < 2) await new Promise((r) => setTimeout(r, 10));
  assert.equal(openStreams, 1);
  tail.stop();
  await tail.done;
  for (let i = 0; openStreams > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(openStreams, 0);
});

test("interceptsFromSnapshot rebuilds the Map shape the extension renders from the tool's JSON", async () => {
  const { interceptsFromSnapshot } = await import("./dist/sandbox.js");
  const row = { feature: "a", service: "api", state: "active" };
  const r = interceptsFromSnapshot(
    JSON.parse(
      JSON.stringify({
        available: true,
        installed: true,
        connected_namespace: "dev",
        intercepts: [row],
        remote_services: ["api", "web"],
      }),
    ),
  );
  assert.equal(r.connectedNamespace, "dev");
  assert.deepEqual(r.byFeature.get("a")?.get("api"), row);
  assert.deepEqual([...r.remoteServices], ["api", "web"]);
});

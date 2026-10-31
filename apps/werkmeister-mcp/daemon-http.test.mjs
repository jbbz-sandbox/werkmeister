// SW-184: the HTTP server as the host daemon, over real HTTP. A per-workspace
// token narrows /mcp to its workspace's verbs and refuses any other workspace;
// /api/tool serves host thin clients on the machine token only; and
// /api/logs/stream follows a workspace's logs as SSE until the client goes away.
//
// Docker is a fake Engine on a unix socket holding one container for workspace
// `a`; WERKMEISTER_FIXTURE keeps the run off Caddy, telepresence and gh.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mintWorkspaceToken } from "werkmeister-core/workspace_token";

import { useDockerEngine } from "../../packages/werkmeister-core/fixtures.mjs";

useDockerEngine();

/** One Engine multiplex frame: stream type, three zero bytes, big-endian length, payload. */
function frame(type, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const CONTAINER = {
  Id: "werkmeister-a-api-1",
  Names: ["/werkmeister-a-api-1"],
  State: "running",
  Status: "Up 1 minute",
  Ports: [],
  Labels: {
    "com.docker.compose.project": "werkmeister-a",
    "com.docker.compose.service": "api",
    "com.docker.compose.container-number": "1",
  },
};

let openFollows = 0;

function fakeDocker(socket) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url.replace(/^\/v[\d.]+/, ""), "http://x");
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/_ping") return res.end("OK");
    if (url.pathname === "/containers/json") {
      // dockerode sends a label filter as a list or as an object keyed by label.
      const filter = JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? [];
      const labels = Array.isArray(filter) ? filter : Object.keys(filter);
      const project = labels.find((l) => l.startsWith("com.docker.compose.project="));
      return json(!project || project.endsWith("=werkmeister-a") ? [CONTAINER] : []);
    }
    if (/^\/containers\/[^/]+\/json$/.test(url.pathname)) {
      return json({ Config: { Tty: false }, State: { Status: "running", Health: null } });
    }
    if (/^\/containers\/[^/]+\/logs$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      res.write(frame(1, "hello from a\n"));
      if (url.searchParams.get("follow") !== "true") return res.end();
      openFollows++;
      req.socket.once("close", () => openFollows--);
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200).flushHeaders();
      return;
    }
    if (url.pathname === "/info") return json({});
    res.writeHead(404).end(JSON.stringify({ message: `no such object: ${url.pathname}` }));
  });
  return new Promise((resolve) => server.listen(socket, () => resolve(server)));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-daemon-http-"));
const home = path.join(tmp, "home");
const root = path.join(tmp, "workspaces");
let base;
let machineToken;
let tokenA;
let docker;
let server;

before(async () => {
  const reg = path.join(tmp, "registry");
  fs.mkdirSync(home);
  fs.mkdirSync(reg);
  fs.writeFileSync(
    path.join(reg, "config.yaml"),
    `version: 1\npaths:\n  workspaces_root: ${root}\n`,
  );
  fs.writeFileSync(path.join(reg, "services.yaml"), "services: {}\n");
  fs.writeFileSync(
    path.join(reg, "ports.yaml"),
    "feature_slots:\n  count: 4\n  base_port: 11100\n  ports_per_slot: 20\n",
  );
  for (const name of ["a", "b"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, ".env"), `FEATURE=${name}\n`);
  }
  // os.homedir() honours HOME: mint into the temp home the server will read.
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  tokenA = mintWorkspaceToken("a", path.join(root, "a"));
  process.env.HOME = prevHome;

  const socket = path.join(tmp, "docker.sock");
  docker = await fakeDocker(socket);
  const port = await freePort();
  server = spawn(process.execPath, ["dist/main.js"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      DOCKER_HOST: `unix://${socket}`,
      WERKMEISTER_CONFIG_FILE: path.join(reg, "config.yaml"),
      WERKMEISTER_FIXTURE: "1",
    },
  });
  let stderr = "";
  server.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; !stderr.includes("listening"); i++) {
    assert.ok(i < 600, `server never listened:\n${stderr}`);
    await sleep(100);
  }
  base = `http://127.0.0.1:${port}`;
  machineToken = fs.readFileSync(path.join(home, ".werkmeister", "mcp-token"), "utf8").trim();
});

after(() => {
  server?.kill("SIGKILL");
  docker?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function mcp(token) {
  const client = new Client({ name: "daemon-http.test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const apiTool = (token, name, args = {}, headers = {}) =>
  fetch(`${base}/api/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ name, arguments: args }),
  });

test("a workspace token lists only the workspace verbs", async () => {
  const client = await mcp(tokenA);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("up") && names.includes("status"));
    for (const hostWide of ["connect", "proxy-reload", "create-workspace", "clean"]) {
      assert.ok(!names.includes(hostWide), `${hostWide} listed for a workspace token`);
    }
  } finally {
    await client.close();
  }
});

test("a workspace token cannot act on another workspace", async () => {
  const client = await mcp(tokenA);
  try {
    const r = await client.callTool({ name: "stop", arguments: { workspace: "b" } });
    assert.ok(r.isError);
    assert.equal(r.structuredContent?.code, "SCOPE");
  } finally {
    await client.close();
  }
});

test("a workspace token's status shows its own workspace only", async () => {
  const client = await mcp(tokenA);
  try {
    // tools/list first: the SDK then validates the result against the output schema.
    await client.listTools();
    const r = await client.callTool({ name: "status", arguments: {} });
    assert.ok(!r.isError, JSON.stringify(r.content));
    assert.deepEqual(
      r.structuredContent.statuses.map((s) => s.name),
      ["a"],
    );
  } finally {
    await client.close();
  }
});

test("/api/tool answers the machine token with structuredContent and text", async () => {
  const res = await apiTool(machineToken, "status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.structuredContent.statuses.map((s) => s.name).sort(), ["a", "b"]);
  assert.match(body.text, /infra:/);
});

test("/api/tool refuses a workspace token, an unknown token and any Origin", async () => {
  assert.equal((await apiTool(tokenA, "status")).status, 403);
  assert.equal((await apiTool("f".repeat(64), "status")).status, 401);
  assert.equal(
    (await apiTool(machineToken, "status", {}, { Origin: "http://evil.example" })).status,
    403,
  );
});

test("/api/tool reports a tool error as 400 with its code", async () => {
  // `b` holds no containers in the fake Engine.
  const res = await apiTool(machineToken, "stop", { workspace: "b" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "NOT_RUNNING");
});

test("/api/logs/stream sends SSE chunks and closes the follow when the client leaves", async () => {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/logs/stream?feature=a`, {
    headers: { Authorization: `Bearer ${machineToken}` },
    signal: abort.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const decoder = new TextDecoder();
  let text = "";
  for await (const bytes of res.body) {
    text += decoder.decode(bytes, { stream: true });
    if (text.includes("hello from a")) break;
  }
  assert.match(text, /^data: ".*hello from a.*"$/m);
  assert.equal(openFollows, 1);
  abort.abort();
  for (let i = 0; openFollows > 0 && i < 100; i++) await sleep(20);
  assert.equal(openFollows, 0, "the daemon kept following after the client left");
});

test("/api/logs/stream refuses another workspace on a workspace token", async () => {
  const res = await fetch(`${base}/api/logs/stream?feature=b`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  assert.equal(res.status, 403);
});

// SW-185: the daemon owns slot leases and the waiting queue. Its store is the
// registry home's scheduler/ files; a client asks over /api/tool.
const leasesFile = () =>
  JSON.parse(fs.readFileSync(path.join(tmp, "registry", "scheduler", "leases.json"), "utf8"));

const scheduler = async (args) => {
  const res = await apiTool(machineToken, "scheduler", args);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).structuredContent.value;
};

test("the scheduler tool leases, reads and releases a slot, on /api/tool only", async () => {
  const ws = path.join(root, "a");
  const slot = await scheduler({ op: "allocate", feature: "lease-me", workspace: ws });
  assert.ok(Number.isInteger(slot));
  assert.deepEqual(await scheduler({ op: "lease", feature: "lease-me" }), { slot, workspace: ws });
  assert.equal(leasesFile()["lease-me"].slot, slot);
  assert.deepEqual(await scheduler({ op: "queue" }), []);
  await scheduler({ op: "release", feature: "lease-me" });
  assert.equal(await scheduler({ op: "lease", feature: "lease-me" }), null);

  const client = await mcp(machineToken);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("scheduler"), "agents never see the scheduler's internal ops");
  } finally {
    await client.close();
  }
});

/** allocateSlot in a fresh client process whose own registry home is *clientHome*. */
function clientAllocate(feature, workspace, { host, clientHome }) {
  const script = `
    import { ttyReporter, withReporter } from "werkmeister-core/reporter";
    import { allocateSlot } from "werkmeister-core/slots";
    const slot = await withReporter(ttyReporter, () =>
      allocateSlot(${JSON.stringify(feature)}, null, ${JSON.stringify(workspace)}));
    console.log("SLOT=" + slot);`;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        HOME: home,
        DOCKER_HOST: `unix://${path.join(tmp, "docker.sock")}`,
        WERKMEISTER_HOST: host,
        WERKMEISTER_CONFIG_FILE: path.join(clientHome, "config.yaml"),
      },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`client exited ${code}:\n${out}`)),
    );
  });
}

const slotOf = (out) => Number(/SLOT=(\d+)/.exec(out)?.[1]);

test("two clients allocating at once go through the daemon and get distinct slots", async () => {
  const clientHome = fs.mkdtempSync(path.join(tmp, "client-"));
  const outs = await Promise.all([
    clientAllocate("c1", path.join(root, "a"), { host: base, clientHome }),
    clientAllocate("c2", path.join(root, "b"), { host: base, clientHome }),
  ]);
  const slots = outs.map(slotOf);
  assert.equal(new Set(slots).size, 2, `both got ${slots}`);
  // In the daemon's store, not the client's own home.
  assert.deepEqual([leasesFile().c1.slot, leasesFile().c2.slot].sort(), [...slots].sort());
  assert.equal(fs.existsSync(path.join(clientHome, "scheduler")), false);
  await scheduler({ op: "release", feature: "c1" });
  await scheduler({ op: "release", feature: "c2" });
});

test("with the daemon down a client warns and schedules in its own process (D1 fallback)", async () => {
  const clientHome = fs.mkdtempSync(path.join(tmp, "client-"));
  fs.writeFileSync(path.join(clientHome, "config.yaml"), "version: 1\n");
  for (const f of ["ports.yaml", "services.yaml"]) {
    fs.copyFileSync(path.join(tmp, "registry", f), path.join(clientHome, f));
  }
  const out = await clientAllocate("solo", path.join(root, "a"), {
    host: "http://127.0.0.1:9",
    clientHome,
  });
  assert.match(out, /daemon not reachable.*Scheduling in this process instead/);
  const local = JSON.parse(
    fs.readFileSync(path.join(clientHome, "scheduler", "leases.json"), "utf8"),
  );
  assert.equal(local.solo.slot, slotOf(out));
});

test("grant-later answers at once with the queue length and drains it in the daemon (D3)", async () => {
  assert.equal(await scheduler({ op: "grant-later" }), 0);
  // A waiter with no lease: the background grant drops it rather than starting it.
  fs.writeFileSync(path.join(tmp, "registry", "scheduler", "queue.json"), '["orphan"]');
  assert.equal(await scheduler({ op: "grant-later" }), 1);
  for (let i = 0; (await scheduler({ op: "queue" })).length; i++) {
    assert.ok(i < 50, "the background grant never drained the queue");
    await sleep(100);
  }
});

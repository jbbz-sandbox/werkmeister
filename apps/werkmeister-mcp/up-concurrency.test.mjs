// SW-183: the HTTP server runs `up` in-process, so two concurrent calls share
// one event loop. Both must finish; a blocking lock wait used to freeze the
// server while the first `up` sat at a Docker await holding the lock.
//
// Docker is a fake on a unix socket (DOCKER_HOST) whose container list answers
// slowly, so each `up` is suspended inside the `allocate` and `caddyfile` locks
// long enough for the other to try them. The workspaces run no local services,
// so no compose runs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pinWerkmeisterRoot, useDockerEngine } from "../../packages/werkmeister-core/fixtures.mjs";

pinWerkmeisterRoot();
useDockerEngine();

const DOCKER_DELAY_MS = 300;

/** Just enough of the Engine API for `up`: no containers, nothing running. */
function fakeDocker(socket) {
  const server = http.createServer(async (req, res) => {
    const p = req.url.replace(/^\/v[\d.]+/, "").split("?")[0];
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p === "/_ping") return res.end("OK");
    if (p === "/containers/json") {
      await sleep(DOCKER_DELAY_MS);
      return json(200, []);
    }
    if (p === "/info") return json(200, {});
    json(404, { message: `no such object: ${p}` });
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

function workspace(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), `FEATURE=${name}\n`);
  fs.writeFileSync(path.join(dir, "compose.yml"), "services: {}\n");
}

test("two concurrent `up` calls through the HTTP MCP server both complete", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-up-concurrency-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "workspaces");
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
  workspace(root, "a");
  workspace(root, "b");

  const socket = path.join(tmp, "docker.sock");
  const docker = await fakeDocker(socket);
  const port = await freePort();
  const server = spawn(process.execPath, ["dist/main.js"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      DOCKER_HOST: `unix://${socket}`,
      WERKMEISTER_CONFIG_FILE: path.join(reg, "config.yaml"),
    },
  });
  let stderr = "";
  server.stderr.on("data", (d) => (stderr += d));
  t.after(() => {
    server.kill("SIGKILL");
    docker.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // Importing every tool takes several seconds on a cold filesystem.
  for (let i = 0; !stderr.includes("listening"); i++) {
    assert.ok(i < 600, `server never listened:\n${stderr}`);
    await sleep(100);
  }

  const callUp = async (ws) => {
    const client = new Client({ name: "up-concurrency.test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    try {
      return await client.callTool({ name: "up", arguments: { workspace: ws } }, undefined, {
        timeout: 20_000,
      });
    } finally {
      await client.close();
    }
  };

  const results = await Promise.all([callUp("a"), callUp("b")]);
  for (const r of results) {
    assert.ok(!r.isError, `up failed: ${JSON.stringify(r.content)}\n${stderr}`);
  }
  const slots = results.map((r) => r.structuredContent?.slot ?? JSON.parse(r.content[0].text).slot);
  assert.equal(new Set(slots).size, 2, `both got slot ${slots}`);
});

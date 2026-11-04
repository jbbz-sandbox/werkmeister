// SW-344: the stdio proxy (`dist/proxy.js`) against a fake daemon. It forwards calls with
// the machine token and the session's workspace, launcher and UI capability as headers;
// turns a changed X-Werkmeister-Build into tools/list_changed; rides out a daemon restart;
// and names the start command when the daemon stays down.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const PROXY = path.join(import.meta.dirname, "dist", "proxy.js");
const UI_MIME = "text/html;profile=mcp-app";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-")));
const wsDir = path.join(tmp, "ws-a");
fs.mkdirSync(path.join(wsDir, ".werkmeister"), { recursive: true });
fs.writeFileSync(path.join(wsDir, ".werkmeister", "workspace.yml"), "feature: a\n");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A daemon stand-in: stateless /mcp with one `echo` tool that returns the headers it saw. */
function fakeDaemon() {
  const daemon = { build: "1.0.0 @ t1", server: null, port: 0, slowAborted: false };
  const handler = async (req, res) => {
    res.setHeader("x-werkmeister-build", daemon.build);
    if (req.url === "/api/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ pid: process.pid, loaded: daemon.build }));
      return;
    }
    const mcp = new McpServer({ name: "fake-daemon", version: "0" });
    mcp.registerTool("echo", { inputSchema: {} }, async (_args, extra) => ({
      content: [{ type: "text", text: JSON.stringify(extra.requestInfo?.headers ?? {}) }],
    }));
    mcp.registerTool("slow", { inputSchema: {} }, async (_args, extra) => {
      await new Promise((resolve) => {
        extra.signal.addEventListener("abort", resolve);
        setTimeout(resolve, 10_000).unref();
      });
      if (extra.signal.aborted) daemon.slowAborted = true;
      return { content: [] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    let body = "";
    for await (const chunk of req) body += chunk;
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  };
  daemon.listen = (port = 0) =>
    new Promise((resolve) => {
      daemon.server = http.createServer(handler);
      daemon.server.listen(port, "127.0.0.1", () => {
        daemon.port = daemon.server.address().port;
        resolve();
      });
    });
  daemon.close = () =>
    new Promise((resolve) => {
      daemon.server.closeAllConnections();
      daemon.server.close(() => resolve());
    });
  return daemon;
}

async function startProxy(t, port, { cwd = wsDir, env = {}, capabilities = {} } = {}) {
  const client = new Client({ name: "proxy.test", version: "0" }, { capabilities });
  const listChanged = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged.push(Date.now());
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [PROXY],
      cwd,
      stderr: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        WERKMEISTER_MCP_PORT: String(port),
        WERKMEISTER_MCP_TOKEN: "tok",
        CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        ...env,
      },
    }),
  );
  t.after(() => client.close());
  return { client, listChanged };
}

const echoHeaders = async (client) =>
  JSON.parse((await client.callTool({ name: "echo", arguments: {} })).content[0].text);

async function until(cond, ms = 5000) {
  for (const end = Date.now() + ms; !cond(); ) {
    assert.ok(Date.now() < end, "timed out");
    await sleep(50);
  }
}

test("forwards list and call with the token, workspace and launcher", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client } = await startProxy(t, daemon.port);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name),
    ["echo", "slow"],
  );
  const seen = await echoHeaders(client);
  assert.equal(seen.authorization, "Bearer tok");
  assert.equal(seen["x-werkmeister-feature"], "ws-a");
  assert.equal(seen["x-werkmeister-launcher"], "vscode");
  assert.equal(seen["x-werkmeister-client-ui"], undefined);
});

test("a changed build header on a response sends tools/list_changed", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client, listChanged } = await startProxy(t, daemon.port);

  await echoHeaders(client);
  assert.equal(listChanged.length, 0);
  daemon.build = "1.0.0 @ t2";
  await echoHeaders(client);
  await until(() => listChanged.length === 1);
});

test("an idle session hears of a rebuild through the status poll", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client, listChanged } = await startProxy(t, daemon.port, {
    env: { WERKMEISTER_PROXY_POLL_MS: "100" },
  });

  await client.listTools();
  daemon.build = "1.0.0 @ t2";
  await until(() => listChanged.length >= 1);
});

test("daemon down: the call fails with the command that starts it", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  const port = daemon.port;
  await daemon.close();
  const { client } = await startProxy(t, port, { env: { WERKMEISTER_PROXY_RETRY_MS: "1000" } });

  const result = await client.callTool({ name: "echo", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /werkmeister infra connect/);
});

test("a call made while the daemon restarts waits for it", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  const { client } = await startProxy(t, daemon.port);
  await client.listTools();

  const port = daemon.port;
  await daemon.close();
  const call = echoHeaders(client);
  await sleep(300);
  await daemon.listen(port);
  t.after(() => daemon.close());
  assert.equal((await call).authorization, "Bearer tok");
});

test("relays the client's UI capability", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client } = await startProxy(t, daemon.port, {
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } },
  });

  assert.equal((await echoHeaders(client))["x-werkmeister-client-ui"], UI_MIME);
});

test("outside a workspace no feature header is sent", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client } = await startProxy(t, daemon.port, {
    cwd: tmp,
    env: { WERKMEISTER_LAUNCHER: "terminal" },
  });

  const seen = await echoHeaders(client);
  assert.equal(seen["x-werkmeister-feature"], undefined);
  assert.equal(seen["x-werkmeister-launcher"], "terminal");
});

test("cancelling a call in the session aborts it in the daemon", async (t) => {
  const daemon = fakeDaemon();
  await daemon.listen();
  t.after(() => daemon.close());
  const { client } = await startProxy(t, daemon.port);

  const abort = new AbortController();
  const call = client.callTool({ name: "slow", arguments: {} }, undefined, {
    signal: abort.signal,
  });
  await sleep(300);
  abort.abort();
  await assert.rejects(call);
  await until(() => daemon.slowAborted);
});

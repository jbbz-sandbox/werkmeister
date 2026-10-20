// The one server's contract (SW-48): every tool once, by its one name, the
// UI-only tools hidden from the model, and the two ui:// resources — over the
// in-memory transport the dashboard's /api/tool uses.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withSandboxHome } from "../../packages/sandbox-core/fixtures.mjs";

// Never the real ~/.sandbox: core resolves its dot dir from HOME.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-home-"));

const { createServer } = await import("./dist/main.js");

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "tools.test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const MERGED = [
  "list-workspaces",
  "create-workspace-form",
  "create-workspace",
  "status",
  "up",
  "stop",
  "restart",
  "down",
  "close-out",
  "connect",
  "open-feature",
  "remove-service",
];
const GONE = [
  "workspace-status",
  "workspace-action",
  "sandbox-connect",
  "open",
  "remove",
  "workspace",
];
const APP_ONLY = [
  "workspace-form-schema",
  "issue-form-data",
  "refine-prompt",
  "issue-statuses",
  "claude-turn-status",
];

test("every verb has one name: the merged names are listed, the old ones are not", async () => {
  const { tools } = await (await connect()).listTools();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no tool registered twice");
  for (const n of MERGED) assert.ok(names.includes(n), `missing ${n}`);
  for (const n of GONE) assert.ok(!names.includes(n), `old name still served: ${n}`);
});

test("the UI-only tools are visible to the app only", async () => {
  const { tools } = await (await connect()).listTools();
  for (const n of APP_ONLY) {
    assert.deepEqual(tools.find((t) => t.name === n)?._meta?.ui?.visibility, ["app"], n);
  }
  assert.equal(
    tools.filter((t) => t._meta?.ui?.visibility).length,
    APP_ONLY.length,
    "no other tool is hidden",
  );
});

test("the App tools point at the form and list resources, and both are listed", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const uri = (n) => tools.find((t) => t.name === n)?._meta?.ui?.resourceUri;
  assert.equal(uri("create-workspace-form"), "ui://workspace/mcp-app.html");
  assert.equal(uri("list-workspaces"), "ui://workspace/mcp-list.html");
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), [
    "ui://workspace/mcp-app.html",
    "ui://workspace/mcp-list.html",
  ]);
});

test("workspace-scoped tools take one optional `workspace` argument", async () => {
  const { tools } = await (await connect()).listTools();
  for (const n of ["up", "down", "open-feature", "close-out", "workspace-pr", "claude-send"]) {
    const schema = tools.find((t) => t.name === n)?.inputSchema;
    assert.ok(schema?.properties?.workspace, `${n} has a workspace argument`);
    assert.ok(!schema?.properties?.feature && !schema?.properties?.name, `${n} has no second id`);
    assert.ok(!(schema?.required ?? []).includes("workspace"), `${n}: workspace is optional`);
  }
});

test("a tool call goes through to core: list-workspaces reads the workspaces root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-root-"));
  fs.mkdirSync(path.join(root, "alpha"));
  try {
    await withSandboxHome(
      async () => {
        const r = await (await connect()).callTool({ name: "list-workspaces", arguments: {} });
        assert.ok(!r.isError, JSON.stringify(r.content));
        assert.deepEqual(
          r.structuredContent.workspaces.map((w) => w.name),
          ["alpha"],
        );
        // No UI capability on this client, so the text is the markdown table.
        assert.match(r.content[0].text, /\| \[alpha\]/);
      },
      { config: `paths:\n  workspaces_root: ${root}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
import { withSandboxHome } from "../../packages/werkmeister-core/fixtures.mjs";

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
  "pause",
  "resume",
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

test("the Claude harness tools keep their names and workspace argument (SW-187)", async () => {
  const { tools } = await (await connect()).listTools();
  for (const n of ["claude-transcript", "claude-send", "claude-turn-status", "claude-resume"]) {
    const t = tools.find((x) => x.name === n);
    assert.ok(t, `missing ${n}`);
    assert.ok(t.description, `${n} has a description`);
    assert.ok(t.inputSchema?.properties?.workspace, `${n} has a workspace argument`);
  }
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
  for (const n of [
    "up",
    "down",
    "pause",
    "resume",
    "open-feature",
    "close-out",
    "workspace-pr",
    "claude-send",
  ]) {
    const schema = tools.find((t) => t.name === n)?.inputSchema;
    assert.ok(schema?.properties?.workspace, `${n} has a workspace argument`);
    assert.ok(!schema?.properties?.feature && !schema?.properties?.name, `${n} has no second id`);
    assert.ok(!(schema?.required ?? []).includes("workspace"), `${n}: workspace is optional`);
  }
});

test("close-out takes an optional skip_postmortem reason beside abandon (SW-108)", async () => {
  const { tools } = await (await connect()).listTools();
  const schema = tools.find((t) => t.name === "close-out")?.inputSchema;
  assert.equal(schema?.properties?.skip_postmortem?.type, "string");
  assert.ok(!(schema?.required ?? []).includes("skip_postmortem"));
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

test("notes: an icm workspace lists its stage-output decisions and graduates one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-root-"));
  const ws = path.join(root, "icmws");
  const std = path.join(root, "standards");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "context_strategy: icm\n");
  fs.mkdirSync(path.join(ws, "stages", "01_reproduce", "output"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "stages", "01_reproduce", "output", "repro.md"),
    "## Proposed fix\n\nstatus: decided\n",
  );
  fs.mkdirSync(path.join(std, "widgets"), { recursive: true });
  fs.writeFileSync(
    path.join(std, "widgets", "STANDARD.md"),
    "---\ndomain: widgets\nsummary: W\n---\n\n# W\n\n## Rules\n\n- a\n\n## Don't\n\n- b\n",
  );
  try {
    await withSandboxHome(
      async () => {
        const client = await connect();
        const list = await client.callTool({
          name: "notes",
          arguments: { workspace: "icmws", action: "list" },
        });
        assert.ok(!list.isError, JSON.stringify(list.content));
        const [decision] = list.structuredContent.decisions;
        assert.equal(
          path.relative(ws, decision.path),
          "stages/01_reproduce/output/repro.md#proposed-fix",
        );

        const r = await client.callTool({
          name: "notes",
          arguments: {
            workspace: "icmws",
            action: "graduate",
            notePath: decision.path,
            domain: "widgets",
            kind: "rule",
          },
        });
        assert.ok(!r.isError, JSON.stringify(r.content));
        assert.match(
          fs.readFileSync(path.join(std, "widgets", "STANDARD.md"), "utf8"),
          /TODO\(graduate\): fill from decision 001, see stages\/01_reproduce\/output\/repro\.md#proposed-fix/,
        );
        assert.match(
          fs.readFileSync(path.join(ws, ".werkmeister", "graduations.yml"), "utf8"),
          /status: graduating/,
        );
      },
      { config: `paths:\n  workspaces_root: ${root}\noverrides:\n  standards_dir: ${std}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-184: the CLI verbs that had no tool, and the reads the VS Code extension polls.
const DAEMON_TOOLS = ["clean", "stats", "optimize", "cache", "registry", "resources", "intercepts"];

test("the daemon tools are listed, and clean/cache prune default to a dry run", async () => {
  const { tools } = await (await connect()).listTools();
  for (const n of DAEMON_TOOLS)
    assert.ok(
      tools.some((t) => t.name === n),
      `missing ${n}`,
    );
  for (const n of ["clean", "cache"]) {
    const dryRun = tools.find((t) => t.name === n)?.inputSchema.properties?.dryRun;
    assert.match(dryRun?.description ?? "", /Default true/, n);
  }
});

test("a workspace-scoped server lists only the workspace verbs", async () => {
  const { WORKSPACE_SCOPED_TOOLS } = await import("./dist/scope.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ scoped: true }).connect(serverSide);
  const client = new Client({ name: "tools.test", version: "0" });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...WORKSPACE_SCOPED_TOOLS].sort());
});

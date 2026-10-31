// Every read-only tool's structuredContent against its outputSchema (SW-229). The SDK
// client validates only after tools/list, which is how container agents call: SW-184's
// strict `status` schema rejected every result there while tests that skip the list passed.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withFakeGh, withSandboxHome } from "../../packages/werkmeister-core/fixtures.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-output-schema-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME);

// A fake Engine with no containers, so `status` never needs a real daemon.
const sock = path.join(tmp, "docker.sock");
const engine = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end("[]");
});
await new Promise((resolve) => engine.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;

after(() => {
  engine.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { createServer } = await import("./dist/main.js");

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "output-schema.test", version: "0" });
  await client.connect(clientSide);
  return client;
}

// Fixture values for required or workspace-scoped arguments; which tools run comes from tools/list.
const ARGS = {
  issue: { ref: "none" },
  "issue-form-data": { ref: "none" },
  "issue-statuses": { refs: [] },
  "workspace-usage": { workspace: "alpha" },
  "claude-transcript": { workspace: "alpha" },
  "claude-turn-status": { workspace: "alpha" },
};

test("every tool says whether it is read-only", async () => {
  const { tools } = await (await connect()).listTools();
  for (const t of tools) {
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name}: set readOnlyHint`);
  }
});

test("every read-only tool's structuredContent matches its outputSchema after tools/list", async () => {
  const root = path.join(tmp, "ws");
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  await withSandboxHome(
    () =>
      withFakeGh({}, async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        const covered = tools.filter((t) => t.outputSchema && t.annotations?.readOnlyHint);
        for (const name of ["status", "resources", "intercepts"]) {
          assert.ok(
            covered.some((t) => t.name === name),
            `${name} is covered`,
          );
        }
        for (const { name } of covered) {
          // callTool rejects with -32602 when structuredContent doesn't match the schema.
          const r = await client
            .callTool({ name, arguments: ARGS[name] ?? {} })
            .catch((e) => assert.fail(`${name}: ${e.message}`));
          // The SDK skips validation on an error result, so an error would hide drift.
          assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
        }
      }),
    {
      config: `paths:\n  workspaces_root: ${root}\noverrides:\n  issue_tracker: github\n  github_org: acme\n`,
    },
  );
});

test("intercepts without a telepresence binary is not an error and matches its schema", async () => {
  const root = path.join(tmp, "ws-no-tp");
  fs.mkdirSync(root, { recursive: true });
  const emptyBin = fs.mkdtempSync(path.join(tmp, "empty-bin-"));
  const prevPath = process.env.PATH;
  await withSandboxHome(
    async () => {
      const client = await connect();
      await client.listTools(); // the SDK validates a result only after tools/list
      process.env.PATH = emptyBin;
      try {
        const r = await client.callTool({ name: "intercepts", arguments: {} });
        assert.ok(!r.isError, JSON.stringify(r.content));
        assert.equal(r.structuredContent.installed, false);
        assert.deepEqual(r.structuredContent.intercepts, []);
      } finally {
        process.env.PATH = prevPath;
      }
    },
    { config: `paths:\n  workspaces_root: ${root}\n` },
  );
});

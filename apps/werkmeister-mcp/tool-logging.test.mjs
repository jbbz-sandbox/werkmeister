// SW-404: a failed MCP tool call keeps its result shape and logs an error bound to the tool and workspace.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { z } from "zod";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tool-logging-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(path.join(process.env.HOME, ".werkmeister"), { recursive: true });
delete process.env.WERKMEISTER_LOG_LEVEL;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { connectInMemoryClient, createServer } = await import("./dist/main.js");
const { adapt } = await import("./dist/tools.js");
const { machineLogPath } = await import("werkmeister-core/logger");

test("a throwing tool returns isError as before and logs an error with the tool, workspace and stack", async () => {
  assert.ok(machineLogPath().startsWith(process.env.HOME), "the log is under the temp HOME");
  const server = createServer();
  server.registerTool(
    "sw404-probe",
    { description: "throws", inputSchema: { workspace: z.string().optional() } },
    async () =>
      adapt(async () => {
        throw new Error("probe failed");
      }),
  );
  const client = await connectInMemoryClient(server, "sw404");
  const res = await client.callTool({ name: "sw404-probe", arguments: { workspace: "demo" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /probe failed/);
  const line = fs
    .readFileSync(machineLogPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.msg === "tool failed");
  assert.ok(line, "logged");
  assert.equal(line.level, "error");
  assert.equal(line.app, "mcp");
  assert.equal(line.command, "sw404-probe");
  assert.equal(line.workspace, "demo");
  assert.match(line.err.stack, /probe failed/);
  await client.close();
});

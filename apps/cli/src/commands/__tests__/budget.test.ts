/**
 * `werkmeister budget status` (SW-186) reports the configured budget, the leases
 * and the Waiting queue from the scheduler's files. A temp HOME has no daemon
 * token, so the queue is read in-process, not over HTTP.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execAsync } from "../../lib/__tests__/helpers/exec_async.js";
import { hostLoadText } from "../budget.js";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
/** Built by the `test` script. */
const MAIN = path.join(CLI_DIR, "dist/main.js");

let home: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  const dot = path.join(home, ".werkmeister");
  fs.mkdirSync(path.join(dot, "scheduler"), { recursive: true });
  fs.writeFileSync(
    path.join(dot, "config.yaml"),
    "budget:\n  memory: 8G\n  cpus: 4\n  host_load: 6\n  preempt: false\n",
  );
  fs.writeFileSync(
    path.join(dot, "scheduler", "leases.json"),
    JSON.stringify({ beta: { slot: 2, workspace: "/ws/beta" }, alpha: { slot: 1, workspace: "" } }),
  );
  // eps waits 12 min for cli (SW-675): its need and wait show.
  const eps = path.join(home, "eps");
  fs.mkdirSync(path.join(eps, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(eps, "compose.yml"),
    "services:\n  cli:\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n        reservations: { memory: 1G }\n",
  );
  fs.writeFileSync(
    path.join(dot, "scheduler", "leases.json"),
    JSON.stringify({
      beta: { slot: 2, workspace: "/ws/beta" },
      alpha: { slot: 1, workspace: "" },
      eps: { slot: 3, workspace: eps },
    }),
  );
  fs.writeFileSync(
    path.join(dot, "scheduler", "queue.json"),
    JSON.stringify(["gamma", "delta", "eps"]),
  );
});
// Per test (SW-1124): the text rounds the wait to minutes, so a `since` from beforeAll read "13 min"
// once the file had run 30 s, as on a loaded host. 11.5 min reads "12 min" for a whole minute of CLI start.
beforeEach(() => {
  fs.writeFileSync(
    path.join(home, "eps", ".werkmeister", "waiting.json"),
    JSON.stringify({
      position: 3,
      reason: "waiting for capacity",
      services: ["cli"],
      since: new Date(Date.now() - 11.5 * 60_000).toISOString(),
    }),
  );
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const env = () => ({
  ...process.env,
  HOME: home,
  WERKMEISTER_CONFIG_FILE: path.join(home, ".werkmeister", "config.yaml"),
  WERKMEISTER_MCP_TOKEN: "",
  PATH: path.dirname(process.execPath),
  // A missing docker: Running reads as unavailable on every host, and no call reaches the real
  // engine (node's dir can hold docker too, e.g. /usr/local/bin with OrbStack).
  WERKMEISTER_DOCKER_BIN: path.join(home, "no-docker"),
});
const budget = (...argv: string[]) =>
  execAsync(process.execPath, [MAIN, "budget", "status", ...argv], { cwd: home, env: env() });

/** Built by turbo before this package: the CLI devDepends on werkmeister-mcp. */
const MCP_DIR = path.resolve(CLI_DIR, "../werkmeister-mcp");
// Run from MCP_DIR so the SDK's bare specifiers resolve from its node_modules.
const CALL_BUDGET_TOOL = `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./dist/server.js";
const [c, s] = InMemoryTransport.createLinkedPair();
await createServer().connect(s);
const client = new Client({ name: "budget.test", version: "0" });
await client.connect(c);
const res = await client.callTool({ name: "budget", arguments: {} });
console.log(JSON.stringify(res.structuredContent));
process.exit(0);
`;

// SW-1006: the views read the `budget` tool; it must say what `budget status --json` says.
it("the budget MCP tool returns the same data as budget status --json", async () => {
  const [cli, tool] = await Promise.all([
    budget("--json"),
    execAsync(process.execPath, ["--input-type=module", "-e", CALL_BUDGET_TOOL], {
      cwd: MCP_DIR,
      env: env(),
    }),
  ]);
  expect(cli.status, cli.stderr).toBe(0);
  expect(tool.status, tool.stderr).toBe(0);
  // waited_ms ticks between the two reads; every other field must match exactly.
  const steady = (o: { waiters: { waited_ms: number }[] }) => ({
    ...o,
    waiters: o.waiters.map((w) => ({ ...w, waited_ms: Math.round(w.waited_ms / 60_000) })),
  });
  const fromTool = JSON.parse(tool.stdout.trim().split("\n").at(-1) ?? "");
  expect(steady(fromTool)).toEqual(steady(JSON.parse(cli.stdout)));
  expect(fromTool.waiters).toHaveLength(3);
});

it("prints the budget, leases and Waiting queue as JSON", async () => {
  const res = await budget("--json");
  expect(res.status, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out).toMatchObject({
    budget: { memory: 8 * 2 ** 30, cpus: 4, preempt: false },
    host_load: 6,
    leases: { beta: { slot: 2, workspace: "/ws/beta" }, alpha: { slot: 1, workspace: "" } },
    waiting: ["gamma", "delta", "eps"],
    running: null,
  });
  // T9. SW-675: each waiter's need, in admission order.
  expect(out.waiters.map((w: { feature: string }) => w.feature)).toEqual(["gamma", "delta", "eps"]);
  expect(out.waiters[2]).toMatchObject({
    position: 3,
    services: ["cli"],
    cpus: 1,
    memory: 2 ** 30,
    gate: false,
  });
  expect(out.waiters[2].waited_ms).toBeGreaterThanOrEqual(11.5 * 60_000);
  expect(out.waiters[0]).toMatchObject({ services: null, cpus: null, waited_ms: 0 });
});

it("lists slots in slot order and the queue in start order", async () => {
  const res = await budget();
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toContain(`Budget: 8 GiB memory, 4 CPUs, ${hostLoadText(6)}, preemption off`);
  expect(res.stdout).toMatch(/Slots:\n {2}1 {2}alpha\n {2}2 {2}beta {2}\/ws\/beta\n/);
  expect(res.stdout).toContain("Running: docker unavailable");
  expect(res.stdout).toMatch(
    /Waiting:\n {2}1\. gamma {2}whole feature\n {2}2\. delta {2}whole feature\n {2}3\. eps {2}cli \(1 CPUs, 1\.0 GiB\) {2}waited 12 min/,
  );
});

// SW-728: the line showed the limit as `host load 24`, a reading. SW-888: macOS and Windows apply it to the Docker VM.
it("labels the host-load limit as a limit, and says where macOS and Windows read it", () => {
  expect(hostLoadText(24, "linux")).toBe("host load limit 24");
  expect(hostLoadText(24, "darwin")).toBe("host load limit 24 (Docker VM load on macOS)");
  expect(hostLoadText(24, "win32")).toBe("host load limit 24 (Docker VM load on Windows)");
  expect(hostLoadText(0, "darwin")).toBe("host load limit off");
});

/**
 * `werkmeister budget status` (SW-186) reports the configured budget, the leases
 * and the Waiting queue from the scheduler's files. A temp HOME has no daemon
 * token, so the queue is read in-process, not over HTTP.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

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
    path.join(eps, ".werkmeister", "waiting.json"),
    JSON.stringify({
      position: 3,
      reason: "waiting for capacity",
      services: ["cli"],
      since: new Date(Date.now() - 12 * 60_000).toISOString(),
    }),
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
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const budget = (...argv: string[]) =>
  spawnSync(process.execPath, [MAIN, "budget", "status", ...argv], {
    cwd: home,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      WERKMEISTER_CONFIG_FILE: path.join(home, ".werkmeister", "config.yaml"),
      WERKMEISTER_MCP_TOKEN: "",
      // No docker on PATH: Running reads as unavailable, the same on every host.
      PATH: path.dirname(process.execPath),
    },
  });

it("prints the budget, leases and Waiting queue as JSON", () => {
  const res = budget("--json");
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
  expect(out.waiters[2].waited_ms).toBeGreaterThanOrEqual(12 * 60_000);
  expect(out.waiters[0]).toMatchObject({ services: null, cpus: null, waited_ms: 0 });
});

it("lists slots in slot order and the queue in start order", () => {
  const res = budget();
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toContain("Budget: 8 GiB memory, 4 CPUs, host load 6, preemption off");
  expect(res.stdout).toMatch(/Slots:\n {2}1 {2}alpha\n {2}2 {2}beta {2}\/ws\/beta\n/);
  expect(res.stdout).toContain("Running: docker unavailable");
  expect(res.stdout).toMatch(
    /Waiting:\n {2}1\. gamma {2}whole feature\n {2}2\. delta {2}whole feature\n {2}3\. eps {2}cli \(1 CPUs, 1\.0 GiB\) {2}waited 12 min/,
  );
});

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
  fs.writeFileSync(path.join(dot, "scheduler", "queue.json"), JSON.stringify(["gamma", "delta"]));
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
    },
  });

it("prints the budget, leases and Waiting queue as JSON", () => {
  const res = budget("--json");
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({
    budget: { memory: 8 * 2 ** 30, cpus: 4, preempt: false },
    host_load: 6,
    leases: { beta: { slot: 2, workspace: "/ws/beta" }, alpha: { slot: 1, workspace: "" } },
    waiting: ["gamma", "delta"],
  });
});

it("lists slots in slot order and the queue in start order", () => {
  const res = budget();
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toContain("Budget: 8 GiB memory, 4 CPUs, host load 6, preemption off");
  expect(res.stdout).toMatch(
    /Slots:\n {2}1 {2}alpha\n {2}2 {2}beta {2}\/ws\/beta\nWaiting:\n {2}1\. gamma\n {2}2\. delta/,
  );
});

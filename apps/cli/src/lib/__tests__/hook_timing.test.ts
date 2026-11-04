/**
 * SW-223: the hook entries the wrapper execs (`werkmeister internal gate|pr-guard|agent-state`
 * → dist/lib/*.js) run on every tool call, so each must add under 200 ms to a bare node start.
 * Budgeted over `node -e 0` measured here, because the bare start alone varies with machine load.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const RUNS = 11;
const BUDGET_MS = 200;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-timing-")));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function timeOnce(args: string[], stdin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: tmp,
      env: { ...process.env, HOME: tmp },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", () => resolve(performance.now() - start));
    child.stdin.end(stdin);
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** Median bare and hook times, each hook run paired with a bare run so both see the same load. */
async function measure(entry: string, stdin: string): Promise<{ bare: number; hook: number }> {
  const bare: number[] = [];
  const hook: number[] = [];
  // Sequential: parallel runs would measure contention, not the entry.
  for (let i = 0; i < RUNS; i++) {
    bare.push(await timeOnce(["-e", "0"], ""));
    hook.push(await timeOnce([entry], stdin));
  }
  return { bare: median(bare), hook: median(hook) };
}

const payload = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "hook-timing",
  tool_name: "Read",
  tool_input: { file_path: path.join(tmp, "x") },
  cwd: tmp,
});

// Under load (a shared CI runner, a machine running a wave) spawn time swings by more than the
// budget, so the check only runs where it means something: locally, on a machine not overloaded.
const overloaded = os.loadavg()[0] > os.cpus().length;
describe.skipIf(Boolean(process.env.CI) || overloaded)("hook entry cold start (SW-223)", () => {
  for (const entry of ["gate", "pr_guard", "agent_state"]) {
    it(`dist/lib/${entry}.js adds < ${BUDGET_MS} ms to node's own start`, async () => {
      const { bare, hook } = await measure(
        path.join(CLI_DIR, "dist", "lib", `${entry}.js`),
        payload,
      );
      expect(hook - bare, `bare ${bare.toFixed(0)} ms, hook ${hook.toFixed(0)} ms`).toBeLessThan(
        BUDGET_MS,
      );
    }, 120_000);
  }
});

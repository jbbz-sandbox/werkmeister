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
    // A missing or crashing entry exits fast, so a time alone would pass it (SW-428).
    child.on("exit", (code) =>
      code === 0
        ? resolve(performance.now() - start)
        : reject(new Error(`node ${args.join(" ")} exited ${code}`)),
    );
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
// HOOK_TIMING_MAX_LOAD=0 forces the over-load path, so it can be shown without loading the host.
const MAX_LOAD = Number(process.env.HOOK_TIMING_MAX_LOAD || os.cpus().length);

/** Why a cold-start time can't be judged at this load, or "" when it can. */
function loadNote(load: number[], max: number): string {
  return load[0] > max
    ? `host load ${load.map((l) => l.toFixed(1)).join(" / ")} (1, 5, 15 min) is over ${max}: cold-start budget not judged`
    : "";
}

describe.skipIf(Boolean(process.env.CI))("hook entry cold start (SW-223)", () => {
  for (const entry of ["gate", "pr_guard", "agent_state"]) {
    it(`dist/lib/${entry}.js adds < ${BUDGET_MS} ms to node's own start`, async (ctx) => {
      // Read per test, not once at import: the gate row's own workers raise the load after collection (SW-868).
      const busy = loadNote(os.loadavg(), MAX_LOAD);
      ctx.skip(Boolean(busy), busy);
      const file = path.join(CLI_DIR, "dist", "lib", `${entry}.js`);
      let { bare, hook } = await measure(file, payload);
      // Load stretches both medians and their gap with them (SW-834): one re-measure, so a real regression still fails twice.
      if (hook - bare >= BUDGET_MS) ({ bare, hook } = await measure(file, payload));
      // The load can rise during the 44 spawns too; a breach under it is the host's, not the entry's.
      if (hook - bare >= BUDGET_MS) {
        const note = loadNote(os.loadavg(), MAX_LOAD);
        ctx.skip(Boolean(note), `${note}; bare ${bare.toFixed(0)} ms, hook ${hook.toFixed(0)} ms`);
      }
      expect(hook - bare, `bare ${bare.toFixed(0)} ms, hook ${hook.toFixed(0)} ms`).toBeLessThan(
        BUDGET_MS,
      );
    }, 120_000);
  }
});

it("a 1-minute load over the limit turns a breach into a load note (SW-868)", () => {
  expect(loadNote([22.8, 20.7, 13.4], 12)).toBe(
    "host load 22.8 / 20.7 / 13.4 (1, 5, 15 min) is over 12: cold-start budget not judged",
  );
  expect(loadNote([12, 30, 30], 12)).toBe("");
});

it("a missing hook entry fails the measurement instead of timing fast", async () => {
  await expect(measure(path.join(CLI_DIR, "dist", "lib", "missing.js"), payload)).rejects.toThrow();
});

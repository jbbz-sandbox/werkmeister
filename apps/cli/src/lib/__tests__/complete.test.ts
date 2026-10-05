/**
 * `sandbox __complete` — the callback behind `complete -C`.
 *
 * Driven as a subprocess like the wrapper test next door, because the
 * completion path is only reachable through main(): its candidates come off
 * the commander program built there, and importing main.ts runs it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");

/** The hoisted-or-local `tsx` binary. Spawned directly: `npx` costs ~3s a call. */
const TSX = [path.join(CLI_DIR, "node_modules/.bin/tsx"), path.join(CLI_DIR, "../../node_modules/.bin/tsx")]
  .find((p) => fs.existsSync(p))!;

let wsRoot: string;

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-complete-"));
  for (const name of ["alpha", "beta"]) fs.mkdirSync(path.join(wsRoot, name));
});
afterAll(() => fs.rmSync(wsRoot, { recursive: true, force: true }));

/** Complete *line*, with the cursor at its end. */
function complete(line: string): string[] {
  const res = spawnSync(TSX, ["src/main.ts", "__complete"], {
    cwd: CLI_DIR,
    encoding: "utf-8",
    env: {
      ...process.env,
      COMP_LINE: line,
      COMP_POINT: String(line.length),
      // Point at a config.yaml that does not exist, so SANDBOX_WORKSPACES_ROOT
      // is what workspacesRoot() resolves — the real config outranks the env var.
      SANDBOX_CONFIG_FILE: path.join(wsRoot, "no-such-config.yaml"),
      SANDBOX_WORKSPACES_ROOT: wsRoot,
    },
  });
  expect(res.status).toBe(0);
  return res.stdout.trim().split("\n").filter(Boolean);
}

// Each case spawns a cold tsx; 5s is not enough when the monorepo suite runs
// these in parallel with everything else.
describe("sandbox __complete", { timeout: 30_000 }, () => {
  it("completes a partial command name", () => {
    expect(complete("sandbox lo")).toEqual(["logs"]);
  });

  it("completes long flags of the named command", () => {
    expect(complete("sandbox up --f")).toEqual(["--force"]);
  });

  it("completes a positional as a feature name", () => {
    // Trailing space: a fresh word, not an extension of "up".
    expect(complete("sandbox up ")).toEqual(["infra", "alpha", "beta"]);
    expect(complete("sandbox up al")).toEqual(["alpha"]);
  });

  it("offers nothing for a command that takes no arguments", () => {
    expect(complete("sandbox list-workspaces ")).toEqual([]);
  });
});

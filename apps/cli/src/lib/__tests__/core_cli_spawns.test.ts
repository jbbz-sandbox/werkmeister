/**
 * `apps/cli` depends on `sandbox-core`, so core must never spawn the `sandbox`
 * binary back — note 087 (.sandbox/notes/087-decision-core-never-drives-the-cli.md).
 *
 * Note 086's five `runSandbox` edges are all closed (row 5, `createWorkspace`,
 * was the last), and `runSandbox` itself is gone, so that half is a flat
 * assertion now rather than a ratchet. What is left is one *direct* spawn:
 * `openFeatureBrowser`, which is pinned below and is the only line anyone may
 * delete from this file. Nothing may ever be added.
 *
 * `resolveSandboxBin`/`childEnv` are deliberately not covered on their own:
 * they exist for *consumers* (claudeck, the VS Code extension) that spawn the
 * CLI themselves, which is core serving a caller rather than core depending on
 * the CLI. What this test forbids is core doing the spawning.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.resolve(fileURLToPath(import.meta.url), "../../../../../../packages/sandbox-core");

/**
 * The functions in core that still launch the `sandbox` binary.
 *
 * `openFeatureBrowser` is not a leftover of the migration: `sandbox open`
 * blocks until the browser window closes, so it is spawned detached and has to
 * outlive the caller. Converting it is a question about who owns a detached
 * browser process, not a move — see note 086.
 */
const REMAINING_SPAWNS = ["openFeatureBrowser"];

/** The function each `resolveSandboxBin()` call in `src` sits inside. */
function enclosingFunctions(src: string, needle: RegExp): string[] {
  const found: string[] = [];
  let current = "unknown";
  for (const line of src.split("\n")) {
    const decl = /^export (?:async )?function (\w+)/.exec(line) ?? /^(?:async )?function (\w+)/.exec(line);
    if (decl) current = decl[1];
    if (needle.test(line)) found.push(current);
  }
  return found;
}

describe("sandbox-core does not drive the CLI", () => {
  const src = fs.readFileSync(path.join(CORE, "sandbox.ts"), "utf8");

  it("has no CLI spawn helper left", () => {
    expect(src).not.toMatch(/\brunSandbox\b/);
  });

  it("resolves the CLI binary only where a spawn is still pinned", () => {
    // `resolveSandboxBin`'s own declaration and the doc references to it are
    // skipped by requiring a call with an argument list on the same line.
    const callers = enclosingFunctions(src, /(?<!function )\bresolveSandboxBin\(/).filter(
      (fn) => fn !== "resolveSandboxBin",
    );
    expect(callers).toEqual(REMAINING_SPAWNS);
  });

  it("spawns the CLI from nowhere else in core", () => {
    const others = fs
      .readdirSync(CORE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "sandbox.ts")
      .filter((f) => /resolveSandboxBin\(|"sandbox"\s*\]/.test(fs.readFileSync(path.join(CORE, f), "utf8")));

    expect(others).toEqual([]);
  });
});

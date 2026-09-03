/**
 * `apps/cli` depends on `sandbox-core`, so core must never spawn the `sandbox`
 * binary back — note 087 (.sandbox/notes/087-decision-core-never-drives-the-cli.md).
 *
 * The table is closed: note 086's five `runSandbox` edges are gone (row 5,
 * `createWorkspace`, was the last), `runSandbox` itself is deleted, and
 * `openFeatureBrowser` — a direct `spawn` the old `runSandbox(` regex never saw
 * — launches the browser in-process now. This is a flat assertion, not a
 * ratchet: nothing may be added.
 *
 * `resolveSandboxBin`/`childEnv` stay exported for *consumers* (claudeck, the
 * VS Code extension) that spawn the CLI themselves, which is core serving a
 * caller rather than core depending on the CLI. What this test forbids is core
 * doing the spawning, which is why it checks call sites rather than exports.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.resolve(fileURLToPath(import.meta.url), "../../../../../../packages/sandbox-core");

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

  it("never resolves the CLI binary for its own use", () => {
    // `resolveSandboxBin`'s own declaration is excluded by the lookbehind; what
    // is left is any *call*, and there must be none.
    const callers = enclosingFunctions(src, /(?<!function )\bresolveSandboxBin\(/).filter(
      (fn) => fn !== "resolveSandboxBin",
    );
    expect(callers).toEqual([]);
  });

  it("spawns the CLI from nowhere else in core", () => {
    const others = fs
      .readdirSync(CORE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "sandbox.ts")
      .filter((f) => /resolveSandboxBin\(|"sandbox"\s*\]/.test(fs.readFileSync(path.join(CORE, f), "utf8")));

    expect(others).toEqual([]);
  });
});

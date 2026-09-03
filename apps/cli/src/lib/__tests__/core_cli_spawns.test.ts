/**
 * `apps/cli` depends on `sandbox-core`, so core must never spawn the `sandbox`
 * binary back — note 087 (.sandbox/notes/087-decision-core-never-drives-the-cli.md).
 * One edge of that cycle is still open (note 086's row 5); this is a
 * ratchet, not a clean bill of health. Every conversion PR deletes its line from
 * REMAINING, and nothing may ever add one.
 *
 * `resolveSandboxBin`/`childEnv` are deliberately NOT covered: they exist for
 * *consumers* (claudeck, the VS Code extension) that spawn the CLI themselves,
 * which is core serving a caller rather than core depending on the CLI.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.resolve(fileURLToPath(import.meta.url), "../../../../../../packages/sandbox-core");

/** The argv of each `runSandbox` call still left in core, as written in the source. */
const REMAINING = [
  "args", // 086 row 5 — createWorkspace, whose CLI self-spawn has to be untangled first
];

describe("sandbox-core does not drive the CLI", () => {
  const src = fs.readFileSync(path.join(CORE, "sandbox.ts"), "utf8");

  it("has only the known-remaining CLI spawns", () => {
    // The first argument of each call: an array literal, or `args` for the
    // dynamically-built one. The lookbehind drops the `function runSandbox(`
    // declaration, which would otherwise match its own typed parameter list.
    const calls = [...src.matchAll(/(?<!function )\brunSandbox\(\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1].replace(/\s+/g, " "),
    );

    expect(calls).toEqual(REMAINING);
  });

  it("spawns the CLI from nowhere else in core", () => {
    const others = fs
      .readdirSync(CORE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "sandbox.ts")
      .filter((f) => /resolveSandboxBin\(|"sandbox"\s*\]/.test(fs.readFileSync(path.join(CORE, f), "utf8")));

    expect(others).toEqual([]);
  });
});

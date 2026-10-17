/**
 * The stdio MCP servers use stdout as their JSON-RPC transport, so one stray
 * `console.log` from an imported library module corrupts the protocol stream —
 * the hazard `reporter.ts` exists to remove. The bug is latent (it fires only
 * when the MCP import graph first reaches the offending module) and has been
 * reintroduced once per migration step, so it is guarded here rather than
 * rediscovered.
 *
 * The four exceptions are deliberate, not yet-to-be-converted. `reporter.ts`
 * is the sink itself. `gate.ts` and `pr_guard.ts` write their hook's deny
 * JSON, which is the PreToolUse contract rather than a log line. `cache.ts` writes to stderr from
 * a module the CLI never reaches — converting it would route its diagnostics
 * to a reporter no consumer of `sandbox.ts` installs, silencing them
 * (.sandbox/notes/033).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../packages/sandbox-core/src",
);
const ALLOWED = new Set(["reporter.ts", "cache.ts", "gate.ts", "pr_guard.ts"]);

describe("sandbox-core console writes", () => {
  it("routes every log through the reporter, outside the documented exceptions", () => {
    const files = [
      ...fs.readdirSync(CORE).filter((f) => f.endsWith(".ts")),
      ...(fs.existsSync(path.join(CORE, "fragment_detect"))
        ? fs
            .readdirSync(path.join(CORE, "fragment_detect"))
            .filter((f) => f.endsWith(".ts"))
            .map((f) => `fragment_detect/${f}`)
        : []),
    ];
    const offenders = files
      .filter((f) => !f.endsWith(".d.ts") && !ALLOWED.has(f))
      .filter((f) => /\bconsole\.\w+\(/.test(fs.readFileSync(path.join(CORE, f), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("finds the files it is scanning", () => {
    expect(fs.existsSync(path.join(CORE, "reporter.ts"))).toBe(true);
  });
});

/**
 * The stdio MCP servers use stdout as their JSON-RPC transport, so one stray
 * `console.log` from an imported library module corrupts the protocol stream —
 * the hazard `reporter.ts` exists to remove. The bug is latent (it fires only
 * when the MCP import graph first reaches the offending module) and has been
 * reintroduced once per migration step, so it is guarded here rather than
 * rediscovered.
 *
 * The three exceptions are deliberate, not yet-to-be-converted. `reporter.ts`
 * is the sink itself. `gate.ts` writes the hook's deny JSON, which is the
 * PreToolUse contract rather than a log line. `cache.ts` writes to stderr from
 * a module the CLI never reaches — converting it would route its diagnostics
 * to a reporter no consumer of `sandbox.ts` installs, silencing them
 * (.sandbox/notes/033).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.resolve(fileURLToPath(import.meta.url), "../../../../../../packages/sandbox-core");
const ALLOWED = new Set(["reporter.ts", "cache.ts", "gate.ts"]);

describe("sandbox-core console writes", () => {
  it("routes every log through the reporter, outside the documented exceptions", () => {
    const offenders = fs
      .readdirSync(CORE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !ALLOWED.has(f))
      .filter((f) => /\bconsole\.\w+\(/.test(fs.readFileSync(path.join(CORE, f), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("finds the files it is scanning", () => {
    expect(fs.existsSync(path.join(CORE, "reporter.ts"))).toBe(true);
  });
});

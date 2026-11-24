/**
 * The stdio MCP servers use stdout as their JSON-RPC transport, so one stray
 * `console.log` from an imported library module corrupts the protocol stream —
 * the hazard `reporter.ts` exists to remove. The bug is latent (it fires only
 * when the MCP import graph first reaches the offending module) and has been
 * reintroduced once per migration step, so it is guarded here rather than
 * rediscovered.
 *
 * The six exceptions are deliberate, not yet-to-be-converted. `reporter.ts`
 * is the sink itself. `gate.ts`, `pr_guard.ts` and `agent_state.ts` (its pause
 * gate, SW-70) write their hook's JSON, which is the hook contract rather than
 * a log line, and only from `main()`, which no server calls. `cache.ts` writes to stderr from
 * a module the CLI never reaches — converting it would route its diagnostics
 * to a reporter no consumer of `sandbox.ts` installs, silencing them
 * (.sandbox/notes/033). `logger.ts` (SW-404) prints one stderr line, once, when it cannot write a log
 * file: the log is the thing that failed, and a reporter line would be teed back into it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../packages/werkmeister-core/src",
);
const ALLOWED = new Set([
  "reporter.ts",
  "cache.ts",
  "gate.ts",
  "pr_guard.ts",
  "agent_state.ts",
  "logger.ts",
]);

describe("werkmeister-core console writes", () => {
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
      // TSDoc blocks are dropped first: an SDK `@example` may call console.log, and comments never run.
      .filter((f) =>
        /\bconsole\.\w+\(/.test(
          fs.readFileSync(path.join(CORE, f), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, ""),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("finds the files it is scanning", () => {
    expect(fs.existsSync(path.join(CORE, "reporter.ts"))).toBe(true);
  });
});

/**
 * SW-97: every `werkmeister …` command that `migrate`'s messages tell the person
 * to run is a command the CLI registers.
 *
 * The registry lives in main.ts, which runs on import, so the program is read
 * through the built binary's `__reference` mode (see lib/__tests__/complete.test.ts).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const MIGRATE_SRC = path.resolve(CLI_DIR, "../../packages/werkmeister-core/src/migrate.ts");

function registeredCommands(): string[] {
  const res = spawnSync(process.execPath, [path.join(CLI_DIR, "dist/main.js"), "__reference"], {
    cwd: CLI_DIR,
    encoding: "utf-8",
  });
  expect(res.status).toBe(0);
  return (JSON.parse(res.stdout) as { name: string }[]).map((c) => c.name);
}

/** The command after `werkmeister` in every backticked span of *source*: `<noun> <verb>` since SW-186. */
function hintedCommands(source: string): string[] {
  return [...source.matchAll(/`werkmeister ([a-z][a-z-]*(?: [a-z][a-z-]*)?)[^`]*`/g)].map(
    (m) => m[1] as string,
  );
}

describe("migrate hints", () => {
  const hinted = hintedCommands(fs.readFileSync(MIGRATE_SRC, "utf-8"));

  it("finds the hints it guards", () => {
    expect(hinted.length).toBeGreaterThan(0);
  });

  it("names only registered CLI commands", () => {
    const registered = registeredCommands();
    // `skills sync` is one command taking an action; `machine migrate` is a noun and verb.
    for (const name of hinted)
      expect(
        registered.includes(name) || registered.includes(name.split(" ")[0] as string),
        `werkmeister ${name}`,
      ).toBe(true);
  });
});

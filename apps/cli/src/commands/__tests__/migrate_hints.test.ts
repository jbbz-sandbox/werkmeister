/**
 * SW-97: every `werkmeister …` command that `migrate`'s messages tell the person
 * to run is a command the CLI registers.
 *
 * The registry lives in main.ts, which runs on import, so the program is read
 * through the built binary's `__reference` mode (see lib/__tests__/complete.test.ts).
 */
import { type ExecFileOptions, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const MIGRATE_SRC = path.resolve(CLI_DIR, "../../packages/werkmeister-core/src/migrate.ts");

/** spawnSync's { status, stdout, stderr } without blocking the vitest worker (SW-744). */
const execAsync = (file: string, args: string[], opts: ExecFileOptions = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile(file, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({
        status: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout,
        stderr,
      }),
    ),
  );

async function registeredCommands(): Promise<string[]> {
  const main = path.join(CLI_DIR, "dist/main.js");
  const res = await execAsync(process.execPath, [main, "__reference"], { cwd: CLI_DIR });
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

  it("names only registered CLI commands", async () => {
    const registered = await registeredCommands();
    // `skills sync` is one command taking an action; `machine migrate` is a noun and verb.
    for (const name of hinted)
      expect(
        registered.includes(name) || registered.includes(name.split(" ")[0] as string),
        `werkmeister ${name}`,
      ).toBe(true);
  });
});

/**
 * `sandbox up` rejects the `-s/--services` and `--force` flags it used to
 * declare but never read (jbbz-sandbox/werkmeister#153).
 *
 * Driven as a subprocess like `complete.test.ts`: the rejection is commander's,
 * so it only happens through main(). Runs from an empty temp dir so that, if the
 * flags were accepted, `up` stops at "Feature name required" before any docker.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execAsync } from "../../lib/__tests__/helpers/exec_async.js";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
/** Built by the `test` script; a cold `tsx src/main.ts` per case transpiles the whole CLI each time (#206). */
const MAIN = path.join(CLI_DIR, "dist/main.js");

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-up-flags-"));
});
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

const sandbox = (...argv: string[]) => execAsync(process.execPath, [MAIN, ...argv], { cwd });

describe("sandbox up flags", () => {
  it.each([["-s", "backend"], ["--services", "backend"], ["--force"]])(
    "rejects %s as unknown",
    async (...argv) => {
      const res = await sandbox("up", ...argv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(`unknown option '${argv[0]}'`);
    },
  );

  // SW-1252: a single-value option kept only the last --service and started that one alone.
  it("refuses a repeated --service instead of starting only the last", async () => {
    const res = await sandbox("feature", "up", "--service", "a", "--service", "b");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("--service takes one service");
  });

  it("no longer lists them in --help", async () => {
    const res = await sandbox("up", "--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--workspace");
    expect(res.stdout).not.toContain("--services");
    expect(res.stdout).not.toContain("--force");
  });
});

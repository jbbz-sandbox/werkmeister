/**
 * `sandbox up` rejects the `-s/--services` and `--force` flags it used to
 * declare but never read (jbbz-sandbox/werkmeister#153).
 *
 * Driven as a subprocess like `complete.test.ts`: the rejection is commander's,
 * so it only happens through main(). Runs from an empty temp dir so that, if the
 * flags were accepted, `up` stops at "Feature name required" before any docker.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
/** Built by the `test` script; a cold `tsx src/main.ts` per case transpiles the whole CLI each time (#206). */
const MAIN = path.join(CLI_DIR, "dist/main.js");

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-up-flags-"));
});
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

const sandbox = (...argv: string[]) =>
  spawnSync(process.execPath, [MAIN, ...argv], { cwd, encoding: "utf-8" });

describe("sandbox up flags", () => {
  it.each([["-s", "backend"], ["--services", "backend"], ["--force"]])(
    "rejects %s as unknown",
    (...argv) => {
      const res = sandbox("up", ...argv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(`unknown option '${argv[0]}'`);
    },
  );

  it("no longer lists them in --help", () => {
    const res = sandbox("up", "--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--workspace");
    expect(res.stdout).not.toContain("--services");
    expect(res.stdout).not.toContain("--force");
  });
});

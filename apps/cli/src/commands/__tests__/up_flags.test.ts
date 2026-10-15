/**
 * `sandbox up` rejects the `-s/--services` and `--force` flags it used to
 * declare but never read (jbbz-sandbox/sandbox#153).
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
const MAIN = path.join(CLI_DIR, "src/main.ts");

/** The hoisted-or-local `tsx` binary. Spawned directly: `npx` costs ~3s a call. */
const TSX = [path.join(CLI_DIR, "node_modules/.bin/tsx"), path.join(CLI_DIR, "../../node_modules/.bin/tsx")]
  .find((p) => fs.existsSync(p))!;

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-up-flags-"));
});
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

const sandbox = (...argv: string[]) => spawnSync(TSX, [MAIN, ...argv], { cwd, encoding: "utf-8" });

describe("sandbox up flags", { timeout: 30_000 }, () => {
  it.each([["-s", "backend"], ["--services", "backend"], ["--force"]])("rejects %s as unknown", (...argv) => {
    const res = sandbox("up", ...argv);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(`unknown option '${argv[0]}'`);
  });

  it("no longer lists them in --help", () => {
    const res = sandbox("up", "--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--workspace");
    expect(res.stdout).not.toContain("--services");
    expect(res.stdout).not.toContain("--force");
  });
});

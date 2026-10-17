/**
 * The three bin scripts declared in package.json: `werkmeister`, `w9r` and the
 * deprecated `sandbox` alias (SW-5; removal is SW-11).
 *
 * Drives the real scripts, so it needs dist/main.js — `npm test` builds first.
 * HOME points at an empty dir so the wrapper never sources the developer's
 * ~/.sandbox/env.sh.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bins-home-"));

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function help(bin: string) {
  const r = spawnSync("bash", [path.join(CLI_DIR, bin), "--help"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("bin scripts", () => {
  for (const bin of ["werkmeister", "w9r"]) {
    it(`${bin} --help works and prints no notice`, () => {
      const r = help(bin);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage: werkmeister");
      expect(r.stderr).toBe("");
    });
  }

  // stderr, so `sandbox <cmd> --json` and piped stdout stay parseable.
  it("sandbox --help prints one deprecation line on stderr, then runs as normal", () => {
    const r = help("sandbox");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: werkmeister");
    expect(r.stdout).not.toContain("sandbox is deprecated");
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deprecated.*werkmeister.*w9r/i);
  });
});

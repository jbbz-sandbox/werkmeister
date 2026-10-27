/**
 * The bin scripts declared in package.json: `werkmeister` and `w9r`.
 *
 * Drives the real scripts, so it needs dist/main.js — `npm test` builds first.
 * HOME points at an empty dir so the wrapper never sources the developer's
 * ~/.werkmeister/env.sh.
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
});

// SW-106: the old name is gone from the package and from what users see.
describe("no sandbox name", () => {
  it("package.json declares only the werkmeister and w9r bins", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8"));
    expect(Object.keys(pkg.bin).sort()).toEqual(["w9r", "werkmeister"]);
    expect(pkg.files).not.toContain("sandbox");
  });

  it("werkmeister --help never says sandbox", () => {
    // Kept on purpose: the sandbox-workspace record repo, and `migrate` naming what it moves.
    const kept = /sandbox-workspace|Move ~\/\.sandbox to/g;
    expect(help("werkmeister").stdout.replace(kept, "")).not.toMatch(/sandbox/i);
  });
});

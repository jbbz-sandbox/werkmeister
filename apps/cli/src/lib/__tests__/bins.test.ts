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

function cli(...argv: string[]) {
  return spawnSync(process.execPath, [path.join(CLI_DIR, "dist/main.js"), ...argv], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
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

// SW-180: grouping reorders the root help; it must not drop, repeat or hide a command.
describe("root --help", () => {
  it("lists every command exactly once", () => {
    const names = JSON.parse(cli("__reference").stdout).map((c: { name: string }) => c.name);
    const terms = help("werkmeister").stdout.match(/^ {2}[a-z][\w-]*/gm) ?? [];
    for (const name of names) expect(terms.filter((t) => t.trim() === name)).toHaveLength(1);
  });

  it("groups commands with the everyday ones first", () => {
    expect(
      help("werkmeister")
        .stdout.match(/^\S.*:$/gm)
        ?.slice(1),
    ).toEqual([
      "Everyday:",
      "Workspaces:",
      "PRs and issues:",
      "Services and infra:",
      "Agent context:",
      "Machine:",
      "Internal:",
    ]);
  });

  it("ends a command's --help with its help.md, built in", () => {
    const md = fs.readFileSync(path.join(CLI_DIR, "src/commands/up.help.md"), "utf8");
    expect(cli("up", "--help").stdout.trimEnd().endsWith(md.trimEnd())).toBe(true);
  });

  it("still suggests a near-miss command", () => {
    const r = cli("stauts");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Did you mean one of stats, status?");
  });
});

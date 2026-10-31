/**
 * The bin scripts declared in package.json: `werkmeister` and `w9r`.
 *
 * Drives the real scripts, so it needs dist/main.js — `npm test` builds first.
 * HOME points at an empty dir so the wrapper never sources the developer's
 * ~/.werkmeister/env.sh.
 */
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const run = promisify(execFile);
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
  it("lists every visible noun and command exactly once, and each verb under its noun", async () => {
    const visible: { name: string }[] = JSON.parse(cli("__reference").stdout).filter(
      (c: { hidden: boolean }) => !c.hidden,
    );
    const terms = (text: string) => text.match(/^ {2}[a-z][\w|-]*/gm)?.map((t) => t.trim()) ?? [];
    const root = terms(help("werkmeister").stdout);
    // One async --help per noun: ~60 spawnSync calls blocked the worker past vitest's RPC timeout.
    const nouns = [...new Set(visible.map((c) => c.name.split(" ")[0]))];
    const nounHelp = new Map(
      await Promise.all(
        nouns.map(async (n) => {
          const { stdout } = await run(
            process.execPath,
            [path.join(CLI_DIR, "dist/main.js"), n, "--help"],
            {
              env: { ...process.env, HOME: home },
            },
          );
          return [n, terms(stdout)] as const;
        }),
      ),
    );
    for (const { name } of visible) {
      const [noun, verb] = name.split(" ");
      expect(root.filter((t) => t.split("|")[0] === noun)).toHaveLength(1);
      if (verb) expect(nounHelp.get(noun)?.filter((t) => t === verb)).toHaveLength(1);
    }
  });

  it("gives docs:gen one entry per verb, with that verb's own flags (SW-186)", () => {
    type Entry = { name: string; hidden: boolean; group: string; options: { long?: string }[] };
    const ref: Entry[] = JSON.parse(cli("__reference").stdout);
    const flags = (name: string) => ref.find((c) => c.name === name)?.options.map((o) => o.long);
    expect(flags("pr open")).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    expect(flags("pr open")).not.toContain("--install");
    expect(flags("pr watch")).toEqual(expect.arrayContaining(["--install", "--uninstall"]));
    expect(ref.find((c) => c.name === "feature up")?.group).toBe("Features:");
    expect(ref.find((c) => c.name === "internal gate")?.hidden).toBe(true);
    expect(ref.find((c) => c.name === "up")?.hidden).toBe(true);
    expect(ref.some((c) => c.name === "feature")).toBe(false);
  });

  it("groups commands with features first", () => {
    expect(
      help("werkmeister")
        .stdout.match(/^\S.*:$/gm)
        ?.slice(1),
    ).toEqual([
      "Features:",
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
    expect(cli("feature", "up", "--help").stdout.trimEnd().endsWith(md.trimEnd())).toBe(true);
  });

  it("still suggests a near-miss command", () => {
    const r = cli("featur");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Did you mean feature?");
    const v = cli("feature", "stauts");
    expect(v.status).toBe(1);
    expect(v.stderr).toContain("Did you mean status?");
  });
});

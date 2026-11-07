/**
 * The bin scripts declared in package.json: `werkmeister` and `w9r`.
 *
 * Drives the real scripts, so it needs dist/main.js — `npm test` builds first.
 * HOME points at an empty dir so the wrapper never sources the developer's
 * ~/.werkmeister/env.sh.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bins-home-"));

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

// Async, never spawnSync: a starved spawn blocking the fork past vitest's fixed 60 s RPC timeout
// ("Timeout calling onTaskUpdate") failed green runs under host load (SW-567). Resolves on any exit code.
function exec(file: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", env: { ...process.env, HOME: home } },
      (_err, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }),
    );
  });
}

const help = (bin: string) => exec("bash", [path.join(CLI_DIR, bin), "--help"]);
const cli = (...argv: string[]) =>
  exec(process.execPath, [path.join(CLI_DIR, "dist/main.js"), ...argv]);

describe("bin scripts", () => {
  for (const bin of ["werkmeister", "w9r"]) {
    it(`${bin} --help works and prints no notice`, async () => {
      const r = await help(bin);
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

  it("werkmeister --help never says sandbox", async () => {
    // Kept on purpose: the sandbox-workspace record repo, and `migrate` naming what it moves.
    const kept = /sandbox-workspace|Move ~\/\.sandbox to/g;
    expect((await help("werkmeister")).stdout.replace(kept, "")).not.toMatch(/sandbox/i);
  });
});

// SW-180: grouping reorders the root help; it must not drop, repeat or hide a command.
describe("root --help", () => {
  it("lists every visible noun and command exactly once, and each verb under its noun", async () => {
    const [reference, rootHelp] = await Promise.all([cli("__reference"), help("werkmeister")]);
    const visible: { name: string }[] = JSON.parse(reference.stdout).filter(
      (c: { hidden: boolean }) => !c.hidden,
    );
    const terms = (text: string) => text.match(/^ {2}[a-z][\w|-]*/gm)?.map((t) => t.trim()) ?? [];
    const root = terms(rootHelp.stdout);
    // One --help per noun, all at once: the case's wall time is one spawn, not ~60.
    const nouns = [...new Set(visible.map((c) => c.name.split(" ")[0]))];
    const nounHelp = new Map(
      await Promise.all(
        nouns.map(async (n) => [n, terms((await cli(n, "--help")).stdout)] as const),
      ),
    );
    for (const { name } of visible) {
      const [noun, verb] = name.split(" ");
      expect(root.filter((t) => t.split("|")[0] === noun)).toHaveLength(1);
      if (verb) expect(nounHelp.get(noun)?.filter((t) => t === verb)).toHaveLength(1);
    }
  });

  it("gives docs:gen one entry per verb, with that verb's own flags (SW-186)", async () => {
    type Entry = { name: string; hidden: boolean; group: string; options: { long?: string }[] };
    const ref: Entry[] = JSON.parse((await cli("__reference")).stdout);
    const flags = (name: string) => ref.find((c) => c.name === name)?.options.map((o) => o.long);
    expect(flags("pr open")).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    expect(flags("pr open")).not.toContain("--install");
    expect(flags("pr watch")).toEqual(expect.arrayContaining(["--install", "--uninstall"]));
    expect(ref.find((c) => c.name === "feature up")?.group).toBe("Features:");
    expect(ref.find((c) => c.name === "internal gate")?.hidden).toBe(true);
    expect(ref.find((c) => c.name === "up")?.hidden).toBe(true);
    expect(ref.some((c) => c.name === "feature")).toBe(false);
  });

  it("groups commands with features first", async () => {
    expect((await help("werkmeister")).stdout.match(/^\S.*:$/gm)?.slice(1)).toEqual([
      "Features:",
      "Workspaces:",
      "PRs and issues:",
      "Services and infra:",
      "Agent context:",
      "Machine:",
      "Internal:",
    ]);
  });

  it("ends a command's --help with its help.md, built in", async () => {
    const md = fs.readFileSync(path.join(CLI_DIR, "src/commands/up.help.md"), "utf8");
    const r = await cli("feature", "up", "--help");
    expect(r.stdout.trimEnd().endsWith(md.trimEnd())).toBe(true);
  });

  it("still suggests a near-miss command", async () => {
    const [r, v] = await Promise.all([cli("featur"), cli("feature", "stauts")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Did you mean feature?");
    expect(v.status).toBe(1);
    expect(v.stderr).toContain("Did you mean status?");
  });
});

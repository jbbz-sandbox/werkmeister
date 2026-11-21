/**
 * SW-555: `internal branch-cli` runs a workspace's werkmeister worktree build from the host with the
 * installed CLI's root and node_modules, and refuses a missing or stale build.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../..");
const MAIN = path.join(CLI_DIR, "dist/main.js");

type Result = { code: number; stdout: string; stderr: string };

function node(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      args,
      { cwd, timeout: 60_000, env: { ...process.env, WERKMEISTER_ROOT: CLI_DIR, ...env } },
      (e, stdout, stderr) =>
        resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

let tmp: string;
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A workspace `<tmp>/ws` with a `.env` and a repo `wm` (cwd for the runs); `cli` adds apps/cli/werkmeister. */
function workspace(cli: boolean): string {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-cli-")));
  const repo = path.join(tmp, "ws", "wm");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ws", ".env"), "FEATURE=demo\n");
  if (cli) {
    fs.mkdirSync(path.join(repo, "apps", "cli"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "cli", "werkmeister"), "");
  }
  return repo;
}

describe("internal branch-cli", () => {
  it("refuses a verb outside pr gate and feature up/stop/status", async () => {
    for (const verb of [["daemon", "restart"], ["machine", "setup"], ["feature", "down"], []]) {
      const r = await node([MAIN, "internal", "branch-cli", ...verb], workspace(true));
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(
        /runs only `pr gate`, `feature up`, `feature stop`, `feature status`/,
      );
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a workspace with no werkmeister worktree", async () => {
    const r = await node([MAIN, "internal", "branch-cli", "feature", "status"], workspace(false));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no werkmeister worktree in .*\/ws/);
  });

  it("refuses an unbuilt worktree and names the in-container build", async () => {
    const r = await node([MAIN, "internal", "branch-cli", "feature", "status"], workspace(true));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "docker exec -w /app demo-werkmeister-core pnpm turbo run build --filter=werkmeister",
    );
  });

  it("runs the worktree's dist with the installed root and node_modules, forwarding args and exit code", async () => {
    const repo = workspace(true);
    const dist = path.join(repo, "apps", "cli", "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(
      path.join(dist, "main.js"),
      "const e = process.env;\n" +
        "console.log(JSON.stringify({ argv: process.argv.slice(2), root: e.WERKMEISTER_ROOT, nodePath: e.NODE_PATH, flag: e.WERKMEISTER_BRANCH_CLI }));\n" +
        "process.exit(3);\n",
    );
    const args = ["pr", "gate", "--tests", "--then", "x"];
    const r = await node([MAIN, "internal", "branch-cli", ...args], repo, {
      NODE_PATH: "/elsewhere",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`branch-cli: running ${path.join(dist, "main.js")}`);
    expect(JSON.parse(r.stdout)).toEqual({
      argv: args,
      root: CLI_DIR,
      nodePath: [path.join(CLI_DIR, "node_modules"), "/elsewhere"].join(path.delimiter),
      flag: "1",
    });
  });

  it("a stale build exits 2 under WERKMEISTER_BRANCH_CLI and only warns without it", async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-cli-")));
    const cli = path.join(tmp, "apps", "cli");
    fs.mkdirSync(path.join(cli, "dist"), { recursive: true });
    fs.copyFileSync(path.join(CLI_DIR, "package.json"), path.join(cli, "package.json"));
    for (const f of fs.readdirSync(path.dirname(MAIN)).filter((f) => f.endsWith(".js")))
      fs.copyFileSync(path.join(path.dirname(MAIN), f), path.join(cli, "dist", f));
    // One commit the bundle's stamp SHA is not in, so its sources count as changed.
    const git = (...a: string[]) =>
      new Promise((res, rej) =>
        execFile("git", ["-C", tmp, ...a], (e) => (e ? rej(e) : res(null))),
      );
    await git("init", "-q");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const copy = path.join(cli, "dist", "main.js");
    const fatal = await node([copy, "--version"], tmp, { WERKMEISTER_BRANCH_CLI: "1" });
    expect(fatal.code).toBe(2);
    expect(fatal.stderr).toMatch(/warning: this werkmeister CLI was built from/);
    const warned = await node([copy, "--version"], tmp, { WERKMEISTER_BRANCH_CLI: "" });
    expect(warned.code).toBe(0);
    expect(warned.stderr).toMatch(/warning: this werkmeister CLI was built from/);
  });
});

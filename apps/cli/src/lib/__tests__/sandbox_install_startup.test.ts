/**
 * sandbox-install-startup.sh `install` mode (SW-33): skip npm ci while the
 * lockfile and Node major match the stamp in node_modules, and queue installs
 * host-wide through flock'd slot files. SW-35: builds run one at a time.
 * SW-31: a pnpm lockfile installs with pnpm, from corepack's shim.
 * SW-85: the stamp has a second copy in the worktree, and both must match.
 *
 * Drives the real script: stub `npm`, `node` and `corepack` on PATH, and stub
 * tool binaries (pnpm too) in SANDBOX_TOOLS_DIR so the download steps are skipped. Needs `flock` and
 * `sha256sum` (util-linux/coreutils), so it runs in the containers and on CI,
 * not on a macOS host.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../..",
  "infra/compose/scripts/sandbox-install-startup.sh",
);
const hasFlock = spawnSync("sh", ["-c", "command -v flock && command -v sha256sum"]).status === 0;

let tmp: string;

function writeExec(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** An app dir with a lockfile and an empty node_modules, as the setup container sees /app. */
function makeApp(name: string): string {
  const app = path.join(tmp, name);
  fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(app, "package-lock.json"), '{"lockfileVersion":3}\n');
  return app;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
    SANDBOX_TOOLS_DIR: path.join(tmp, "tools"),
    SANDBOX_INSTALL_LOCKS: path.join(tmp, "locks"),
    LOG: path.join(tmp, "npm.log"),
    INFLIGHT: path.join(tmp, "inflight"),
    PEAKS: path.join(tmp, "peaks"),
    BUILD_INFLIGHT: path.join(tmp, "build-inflight"),
    BUILD_PEAKS: path.join(tmp, "build-peaks"),
    NODE_V: "v22.1.0",
    ...extra,
  };
}

function run(app: string, extra: Record<string, string> = {}, args = ["install"]) {
  return spawnSync("sh", [SCRIPT, ...args], { cwd: app, env: env(extra), encoding: "utf8" });
}

/** Calls logged since the last read: `<args>` for npm, `pnpm <args>` / `corepack <args>` for those. */
function npmCalls(): string[] {
  const log = path.join(tmp, "npm.log");
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(log, { force: true });
  return lines.filter(Boolean);
}

const stamp = (app: string) => path.join(app, "node_modules", ".sandbox-install-hash");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-install-"));
  // `ci` counts itself in INFLIGHT while it "installs", so the queue case can see overlap.
  writeExec(
    path.join(tmp, "bin", "npm"),
    [
      'echo "$*" >> "$LOG"',
      'if [ "$1" = ci ]; then',
      '  [ "${FAIL_CI:-}" = 1 ] && exit 1',
      '  mkdir -p "$INFLIGHT/$$"',
      '  ls "$INFLIGHT" | wc -l >> "$PEAKS"',
      '  sleep "${CI_SECONDS:-0}"',
      '  rmdir "$INFLIGHT/$$"',
      "fi",
      'if [ "$1" = run ]; then',
      '  mkdir -p "$BUILD_INFLIGHT/$$"',
      '  ls "$BUILD_INFLIGHT" | wc -l >> "$BUILD_PEAKS"',
      '  sleep "${BUILD_SECONDS:-0}"',
      '  rmdir "$BUILD_INFLIGHT/$$"',
      "fi",
    ].join("\n"),
  );
  writeExec(path.join(tmp, "bin", "node"), 'echo "$NODE_V"');
  // Stands in for `corepack enable --install-directory <dir> pnpm`: drops the shim in <dir>.
  writeExec(
    path.join(tmp, "bin", "corepack"),
    ['echo "corepack $*" >> "$LOG"', `cp "${path.join(tmp, "pnpm-stub")}" "$3/pnpm"`].join("\n"),
  );
  writeExec(path.join(tmp, "pnpm-stub"), 'echo "pnpm $*" >> "$LOG"');
  writeExec(path.join(tmp, "tools", "bin", "pnpm"), 'echo "pnpm $*" >> "$LOG"');
  for (const tool of ["bin/docker", "bin/kubectl", "docker/cli-plugins/docker-compose"]) {
    writeExec(path.join(tmp, "tools", tool), "exit 0");
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasFlock)("sandbox-install-startup.sh install", () => {
  it("installs once, then skips npm ci while nothing changed", () => {
    const app = makeApp("app");
    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["ci", "run build"]);
    expect(fs.existsSync(stamp(app))).toBe(true);

    const second = run(app);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("skipping npm ci");
    expect(npmCalls()).toEqual(["run build"]);
  });

  it("reinstalls when the lockfile changes", () => {
    const app = makeApp("app");
    run(app);
    npmCalls();
    fs.writeFileSync(path.join(app, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["ci", "run build"]);
  });

  it("reinstalls when the Node major changes, not the minor", () => {
    const app = makeApp("app");
    run(app);
    npmCalls();
    run(app, { NODE_V: "v22.9.0" });
    expect(npmCalls()).toEqual(["run build"]);
    run(app, { NODE_V: "v24.0.0" });
    expect(npmCalls()).toEqual(["ci", "run build"]);
  });

  it("writes no stamp when npm ci fails, so the next run retries", () => {
    const app = makeApp("app");
    run(app);
    fs.writeFileSync(path.join(app, "package-lock.json"), '{"lockfileVersion":3,"x":2}\n');
    npmCalls();

    expect(run(app, { FAIL_CI: "1" }).status).not.toBe(0);
    expect(fs.existsSync(stamp(app))).toBe(false);
    expect(npmCalls()).toEqual(["ci"]);

    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["ci", "run build"]);
  });

  it("reinstalls when the worktree is re-created on a kept node_modules volume (SW-85)", () => {
    const app = makeApp("app");
    run(app);
    npmCalls();
    // app/node_modules stands in for the volume: it survives, the worktree around it is new.
    for (const f of fs.readdirSync(app)) {
      if (f !== "node_modules") fs.rmSync(path.join(app, f), { recursive: true });
    }
    fs.writeFileSync(path.join(app, "package-lock.json"), '{"lockfileVersion":3}\n');
    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["ci", "run build"]);

    // ...and only once: the next up of the same worktree skips again.
    run(app);
    expect(npmCalls()).toEqual(["run build"]);
  });

  it("reinstalls when the volume is dropped and the worktree kept (`down -v`)", () => {
    const app = makeApp("app");
    run(app);
    npmCalls();
    fs.rmSync(path.join(app, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(app, "node_modules"));
    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["ci", "run build"]);
  });

  it("installs with pnpm when the app has a pnpm lockfile, with the same skip (SW-31)", () => {
    const app = makeApp("app");
    fs.rmSync(path.join(app, "package-lock.json"));
    fs.writeFileSync(path.join(app, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(run(app).status).toBe(0);
    expect(npmCalls()).toEqual(["pnpm install --frozen-lockfile", "pnpm run build"]);

    const second = run(app);
    expect(second.stdout).toContain("skipping pnpm install");
    expect(npmCalls()).toEqual(["pnpm run build"]);
  });

  it("adds corepack's pnpm shim to the tools volume once, in either mode", () => {
    const app = makeApp("app");
    const tools = path.join(tmp, "tools", "bin");
    fs.rmSync(path.join(tools, "pnpm"));
    expect(run(app, {}, []).status).toBe(0);
    expect(npmCalls()).toEqual([`corepack enable --install-directory ${tools} pnpm`]);
    expect(run(app, {}, []).status).toBe(0);
    expect(npmCalls()).toEqual([]);
  });

  it("does not install without the `install` argument (the pre-SW-33 command)", () => {
    const app = makeApp("app");
    expect(run(app, {}, []).status).toBe(0);
    expect(npmCalls()).toEqual([]);
  });

  it("runs at most SANDBOX_INSTALL_SLOTS installs at once across workspaces", async () => {
    const runs = [1, 2, 3, 4, 5].map(
      (n) =>
        new Promise<number | null>((resolve) => {
          const child = spawn("sh", [SCRIPT, "install"], {
            cwd: makeApp(`ws${n}`),
            env: env({ CI_SECONDS: "2", SANDBOX_INSTALL_SLOTS: "2" }),
            stdio: "ignore",
          });
          child.on("close", resolve);
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0]);
    expect(npmCalls().filter((c) => c === "ci")).toHaveLength(5);
    const peak = Math.max(
      ...fs.readFileSync(path.join(tmp, "peaks"), "utf8").trim().split("\n").map(Number),
    );
    // > 1 shows it is a queue of 2, not a single global mutex.
    expect(peak).toBe(2);
  });

  it("builds one workspace at a time, so they share the turbo cache safely (SW-35)", async () => {
    const runs = [1, 2, 3, 4, 5].map(
      (n) =>
        new Promise<number | null>((resolve) => {
          const child = spawn("sh", [SCRIPT, "install"], {
            cwd: makeApp(`ws${n}`),
            env: env({ BUILD_SECONDS: "1", SANDBOX_INSTALL_SLOTS: "5" }),
            stdio: "ignore",
          });
          child.on("close", resolve);
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0]);
    const peaks = fs.readFileSync(path.join(tmp, "build-peaks"), "utf8").trim().split("\n");
    expect(peaks).toHaveLength(5);
    expect(Math.max(...peaks.map(Number))).toBe(1);
  });
});

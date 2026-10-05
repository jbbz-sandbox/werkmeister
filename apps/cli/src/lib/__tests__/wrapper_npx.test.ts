/**
 * The `sandbox` wrapper's npx-bootstrap branch.
 *
 * npx resolves the CLI inside ~/.npm/_npx/<hash>/, a cache npm re-hashes on
 * every version change and garbage-collects. `setup`/`config` persist
 * SANDBOX_ROOT into ~/.sandbox, and the compose generator bakes it into each
 * workspace's docker-compose.yml as a bind mount — so running from there pins
 * permanent state to a directory that will vanish. The wrapper installs
 * globally and hands off instead.
 *
 * Bash, so this drives the real script rather than importing anything: a stub
 * `npm` on PATH stands in for the global install, and a stub `sandbox` for the
 * installed binary the wrapper should exec.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WRAPPER = path.resolve(fileURLToPath(import.meta.url), "../../../..", "sandbox");

let tmp: string;

/** Lay out a package dir at `pkgDir` holding a copy of the real wrapper. */
function installWrapper(pkgDir: string): string {
  fs.mkdirSync(pkgDir, { recursive: true });
  const wrapper = path.join(pkgDir, "sandbox");
  fs.copyFileSync(WRAPPER, wrapper);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@jbbz-sandbox/sandbox-cli", version: "9.9.9" }),
  );
  return wrapper;
}

/** A stub `npm` whose `prefix -g` points at *prefix* and whose install is a no-op. */
function stubNpm(binDir: string, prefix: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const npm = path.join(binDir, "npm");
  fs.writeFileSync(
    npm,
    `#!/bin/bash\n` +
      `[ "$1" = "prefix" ] && { echo "${prefix}"; exit 0; }\n` +
      `[ "$1" = "install" ] && { echo "STUB-INSTALL $*"; exit 0; }\n` +
      `exit 0\n`,
  );
  fs.chmodSync(npm, 0o755);
}

/**
 * Run the wrapper, returning stdout+stderr together — the wrapper sends its
 * progress and the install's own output to stderr, so a stdout-only capture
 * would miss the half this asserts on. Throws with both streams on a non-zero
 * exit, which is what the not-built case checks.
 */
function run(wrapper: string, args: string[], pathPrefix: string): string {
  const result = spawnSync("bash", [wrapper, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SANDBOX_ROOT: "",
      HOME: tmp, // no ~/.sandbox/env.sh to source
      PATH: `${pathPrefix}:${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(output);
  }
  return output;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-npx-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Each case drives the real bash wrapper through spawnSync, which forks bash,
// an npm stub and an exec'd stand-in binary. ~1.6s idle, but >5s under a full
// `turbo run test` -- so vitest's 5s default fails these on load, not on merit.
const SPAWNS_BASH = 30_000;

describe("sandbox wrapper: npx bootstrap", () => {
  it("installs globally and execs the installed binary when run from npx's cache", () => {
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    // Stand-in for the globally installed CLI: prove the wrapper reached it,
    // and that it forwarded argv.
    fs.writeFileSync(
      path.join(prefix, "bin", "sandbox"),
      `#!/bin/bash\necho "GLOBAL-RAN $*"\n`,
    );
    fs.chmodSync(path.join(prefix, "bin", "sandbox"), 0o755);

    const stubs = path.join(tmp, "stubs");
    stubNpm(stubs, prefix);
    const wrapper = installWrapper(
      path.join(tmp, "_npx", "deadbeef", "node_modules", "@jbbz-sandbox", "sandbox-cli"),
    );

    const out = run(wrapper, ["setup", "--check"], stubs);
    // Pinned to the version npx resolved (9.9.9 here), not @latest — otherwise
    // `npx pkg@1.2.3 setup` would onboard the machine onto a different release.
    expect(out).toContain("STUB-INSTALL install -g @jbbz-sandbox/sandbox-cli@9.9.9");
    expect(out).toContain("GLOBAL-RAN setup --check");
  }, SPAWNS_BASH);

  it("does not bootstrap from a normal install path", () => {
    const stubs = path.join(tmp, "stubs");
    stubNpm(stubs, path.join(tmp, "unused"));
    // No _npx in the path, and no dist/ — so it must fall through to the
    // not-built error rather than trying to install anything.
    const wrapper = installWrapper(path.join(tmp, "lib", "node_modules", "sandbox-cli"));

    expect(() => run(wrapper, ["--help"], stubs)).toThrowError(/CLI not built/);
  });
});

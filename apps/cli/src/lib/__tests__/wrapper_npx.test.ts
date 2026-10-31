/**
 * The `werkmeister` wrapper's npx-bootstrap branch.
 *
 * npx resolves the CLI inside ~/.npm/_npx/<hash>/, a cache npm re-hashes on
 * every version change and garbage-collects. `setup`/`config` persist
 * WERKMEISTER_ROOT into ~/.sandbox, and the compose generator bakes it into each
 * workspace's compose.yml as a bind mount — so running from there pins
 * permanent state to a directory that will vanish. The wrapper installs
 * globally and hands off instead.
 *
 * Bash, so this drives the real script rather than importing anything: a stub
 * `npm` on PATH stands in for the global install, and a stub `sandbox` for the
 * installed binary the wrapper should exec.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WRAPPER = path.resolve(fileURLToPath(import.meta.url), "../../../..", "werkmeister");

let tmp: string;

/** Lay out a package dir at `pkgDir` holding a copy of the real wrapper. */
function installWrapper(pkgDir: string): string {
  fs.mkdirSync(pkgDir, { recursive: true });
  const wrapper = path.join(pkgDir, "werkmeister");
  fs.copyFileSync(WRAPPER, wrapper);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "werkmeister", version: "9.9.9" }),
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
async function run(wrapper: string, args: string[], pathPrefix: string): Promise<string> {
  try {
    const { stdout, stderr } = await promisify(execFile)("bash", [wrapper, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        WERKMEISTER_ROOT: "",
        HOME: tmp, // no ~/.sandbox/env.sh to source
        PATH: `${pathPrefix}:${process.env.PATH}`,
      },
    });
    return `${stdout}${stderr}`;
  } catch (e) {
    const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
    throw new Error(`${stdout}${stderr}` || String(e));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-npx-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The bootstrap case execs a fresh npm stub and a fresh stand-in binary. macOS
// checks each newly written executable on its first exec (~6s for this case at
// load ~24), and that check slows with host load: 30s timed out at load 250-400
// on 12 cores (SW-277). The limit is for load, not merit. `run` is async because
// a worker blocked past vitest's 60s RPC timeout fails the whole run.
const SPAWNS_BASH = 120_000;

describe("werkmeister wrapper: npx bootstrap", () => {
  it(
    "installs globally and execs the installed binary when run from npx's cache",
    async () => {
      const prefix = path.join(tmp, "prefix");
      fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
      // Stand-in for the globally installed CLI: prove the wrapper reached it,
      // and that it forwarded argv.
      fs.writeFileSync(
        path.join(prefix, "bin", "werkmeister"),
        `#!/bin/bash\necho "GLOBAL-RAN $*"\n`,
      );
      fs.chmodSync(path.join(prefix, "bin", "werkmeister"), 0o755);

      const stubs = path.join(tmp, "stubs");
      stubNpm(stubs, prefix);
      const wrapper = installWrapper(
        path.join(tmp, "_npx", "deadbeef", "node_modules", "werkmeister"),
      );

      const out = await run(wrapper, ["setup", "--check"], stubs);
      // Pinned to the version npx resolved (9.9.9 here), not @latest — otherwise
      // `npx pkg@1.2.3 setup` would onboard the machine onto a different release.
      expect(out).toContain("STUB-INSTALL install -g werkmeister@9.9.9");
      expect(out).toContain("GLOBAL-RAN setup --check");
    },
    SPAWNS_BASH,
  );

  it("does not bootstrap from a normal install path", async () => {
    const stubs = path.join(tmp, "stubs");
    stubNpm(stubs, path.join(tmp, "unused"));
    // No _npx in the path, and no dist/ — so it must fall through to the
    // not-built error rather than trying to install anything.
    const wrapper = installWrapper(path.join(tmp, "lib", "node_modules", "werkmeister"));

    await expect(run(wrapper, ["--help"], stubs)).rejects.toThrowError(/CLI not built/);
  });
});

/**
 * `werkmeister pr watch --install / --uninstall` through the built CLI (SW-14):
 * install, rerun, remove against a temp HOME. Stub `launchctl` and `crontab` on
 * PATH log their argv and keep the crontab in a file, so the real launchd
 * domain and crontab are never touched. The binary takes the host's platform —
 * launchd on macOS, cron in the Linux container; the unit test covers both.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
/** Built by the `test` script. */
const MAIN = path.join(CLI_DIR, "dist/main.js");
const launchd = process.platform === "darwin";

let tmp: string;
let home: string;
let env: NodeJS.ProcessEnv;

const stub = (name: string, body: string) => {
  const file = path.join(tmp, "bin", name);
  fs.writeFileSync(file, `#!/bin/bash\necho "${name} $*" >> "${tmp}/calls.log"\n${body}`);
  fs.chmodSync(file, 0o755);
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-install-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  stub("launchctl", "exit 0\n");
  stub(
    "crontab",
    `tab="${tmp}/crontab"\n` +
      `if [ "$1" = "-l" ]; then [ -s "$tab" ] && cat "$tab" && exit 0; echo "no crontab for user" >&2; exit 1; fi\n` +
      `cp "$1" "$tab"\n`,
  );
  env = { ...process.env };
  for (const k of [
    "WERKMEISTER_ROOT",
    "WERKMEISTER_ROOT",
    "WERKMEISTER_CONFIG_FILE",
    "WERKMEISTER_CONFIG_FILE",
  ])
    delete env[k];
  Object.assign(env, {
    HOME: home,
    WERKMEISTER_CONFIG_FILE: path.join(home, ".werkmeister", "config.yaml"),
    PATH: `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`,
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cli = (...argv: string[]) =>
  spawnSync(process.execPath, [MAIN, "pr", ...argv], { cwd: tmp, env, encoding: "utf-8" });
const plist = () => path.join(home, "Library", "LaunchAgents", "com.werkmeister.pr-watch.plist");
const scheduled = () => {
  if (launchd) return fs.existsSync(plist()) ? fs.readFileSync(plist(), "utf8") : "";
  const tab = path.join(tmp, "crontab");
  return fs.existsSync(tab) ? fs.readFileSync(tab, "utf8") : "";
};
const calls = () => {
  const log = path.join(tmp, "calls.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
};
const writeCalls = () =>
  calls()
    .split("\n")
    .filter((l) => /^launchctl bootstrap|^crontab (?!-l)/.test(l));

describe("pr watch --install / --uninstall (built binary)", () => {
  const logFile = () => path.join(home, ".werkmeister", "pr-watch.log");

  it("installs and says where the logs go", () => {
    const res = cli("watch", "--install");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(launchd ? plist() : "crontab line");
    expect(res.stdout).toContain(logFile());
    expect(res.stdout).toContain("werkmeister pr watch --uninstall");
    expect(scheduled()).toContain(path.join(CLI_DIR, "werkmeister"));
    expect(scheduled()).toContain(launchd ? "<string>watch</string>" : "pr watch");
    expect(fs.existsSync(path.dirname(logFile()))).toBe(true);
  });

  it("is idempotent on a rerun", () => {
    const before = writeCalls().length;
    const res = cli("watch", "--install");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Already installed");
    expect(writeCalls()).toHaveLength(before);
    if (launchd) expect(fs.readdirSync(path.dirname(plist()))).toHaveLength(1);
    else expect(scheduled().match(/# werkmeister pr watch/g)).toHaveLength(1);
  });

  it("uninstalls cleanly", () => {
    const res = cli("watch", "--uninstall");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Removed");
    expect(scheduled()).not.toContain("pr watch");
  });

  it("reports nothing to remove on a second uninstall", () => {
    const res = cli("watch", "--uninstall");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("No PR watch schedule installed");
  });

  it("refuses both flags at once", () => {
    const res = cli("watch", "--install", "--uninstall");
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("Pick one of --install or --uninstall.");
  });

  it("refuses the flags on another action", () => {
    const res = cli("status", "--install");
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("--install/--uninstall go with `pr watch`.");
  });
});

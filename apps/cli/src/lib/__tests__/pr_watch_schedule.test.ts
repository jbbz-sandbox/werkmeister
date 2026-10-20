/**
 * The `pr watch` schedule (SW-14): install, rerun and remove, for both kinds on
 * every host. A fake Runner stands in for `launchctl` and keeps the crontab in
 * memory, so nothing reaches the real launchd domain or crontab.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installPrWatchSchedule,
  PR_WATCH_CRON_MARKER,
  type PrWatchScheduleOptions,
  prWatchScheduleState,
  type Runner,
  syncPrWatchSchedule,
  uninstallPrWatchSchedule,
} from "werkmeister-core/machine_setup";

let tmp: string;
let calls: string[][];
let crontab: string;

/** Records every call; `crontab -l` / `crontab <file>` read and write `crontab`. */
const fakeRunner =
  (overrides: Record<string, [number, string]> = {}): Runner =>
  (cmd) => {
    calls.push(cmd);
    const hit = overrides[cmd.slice(0, 2).join(" ")] ?? overrides[cmd[0]];
    if (hit) return hit;
    if (cmd[0] === "crontab" && cmd[1] === "-l") {
      return crontab ? [0, crontab.trim()] : [1, "no crontab for u"];
    }
    if (cmd[0] === "crontab") {
      crontab = fs.readFileSync(cmd[1], "utf8");
      return [0, ""];
    }
    return [0, ""];
  };

function opts(
  platform: NodeJS.Platform,
  extra: Partial<PrWatchScheduleOptions> = {},
): PrWatchScheduleOptions {
  return {
    platform,
    home: path.join(tmp, "home"),
    logFile: path.join(tmp, "cfg", "pr-watch.log"),
    // A space and a `%` prove the quoting and cron's `%` escape.
    wrapper: "/opt/w m/werkmeister",
    pathEnv: "/a%b:/usr/bin",
    uid: 501,
    runner: fakeRunner(),
    ...extra,
  };
}

const plistPath = () =>
  path.join(tmp, "home", "Library", "LaunchAgents", "com.werkmeister.pr-watch.plist");
const writes = () => calls.filter((c) => c[0] === "crontab" && c[1] !== "-l");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-schedule-"));
  calls = [];
  crontab = "";
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("launchd", () => {
  it("installs a plist that runs pr watch every 600s, logging both streams", () => {
    const res = installPrWatchSchedule(opts("darwin"));
    expect(res.ok).toBe(true);
    const plist = fs.readFileSync(plistPath(), "utf8");
    expect(plist).toContain("<string>com.werkmeister.pr-watch</string>");
    expect(plist).toContain("<integer>600</integer>");
    expect(plist).toContain("<string>/opt/w m/werkmeister</string>");
    expect(plist).toContain("<string>pr</string>");
    expect(plist).toContain("<string>watch</string>");
    expect(plist).toContain("<string>/a%b:/usr/bin</string>");
    expect(plist.split(path.join(tmp, "cfg", "pr-watch.log")).length - 1).toBe(2);
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/com.werkmeister.pr-watch"],
      ["launchctl", "bootstrap", "gui/501", plistPath()],
    ]);
    expect(res.lines.join("\n")).toContain(`Logs: ${path.join(tmp, "cfg", "pr-watch.log")}`);
    expect(res.lines.join("\n")).toContain("werkmeister pr watch --uninstall");
  });

  it("XML-escapes interpolated paths", () => {
    installPrWatchSchedule(opts("darwin", { wrapper: "/x&y/<w>" }));
    expect(fs.readFileSync(plistPath(), "utf8")).toContain("/x&#38;y/&#60;w&#62;");
  });

  it("is a no-op on an unchanged rerun", () => {
    installPrWatchSchedule(opts("darwin"));
    const mtime = fs.statSync(plistPath()).mtimeMs;
    calls = [];
    const res = installPrWatchSchedule(opts("darwin"));
    expect(res.ok).toBe(true);
    expect(res.lines[0]).toMatch(/^Already installed/);
    expect(calls).toEqual([]);
    expect(fs.statSync(plistPath()).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(path.dirname(plistPath()))).toHaveLength(1);
  });

  it("rewrites and reloads when the PATH moved", () => {
    installPrWatchSchedule(opts("darwin"));
    calls = [];
    expect(prWatchScheduleState(opts("darwin", { pathEnv: "/new" })).current).toBe(false);
    installPrWatchSchedule(opts("darwin", { pathEnv: "/new" }));
    expect(fs.readFileSync(plistPath(), "utf8")).toContain("<string>/new</string>");
    expect(calls.map((c) => c[1])).toEqual(["bootout", "bootstrap"]);
    expect(fs.readdirSync(path.dirname(plistPath()))).toHaveLength(1);
  });

  it("uninstalls, and a second uninstall reports nothing installed", () => {
    installPrWatchSchedule(opts("darwin"));
    calls = [];
    expect(uninstallPrWatchSchedule(opts("darwin")).lines[0]).toMatch(/^Removed launchd agent/);
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(calls).toEqual([["launchctl", "bootout", "gui/501/com.werkmeister.pr-watch"]]);
    const again = uninstallPrWatchSchedule(opts("darwin"));
    expect(again).toEqual({ ok: true, lines: ["No PR watch schedule installed."] });
  });

  it("fails on a bootstrap error and keeps the plist for a retry", () => {
    const runner = fakeRunner({
      "launchctl bootstrap": [5, "Bootstrap failed: 5: Input/output error"],
    });
    const res = installPrWatchSchedule(opts("darwin", { runner }));
    expect(res.ok).toBe(false);
    expect(res.lines.join(" ")).toContain("Input/output error");
    expect(fs.existsSync(plistPath())).toBe(true);
  });

  it("reports installed and current after install, stale after the wrapper moved", () => {
    installPrWatchSchedule(opts("darwin"));
    expect(prWatchScheduleState(opts("darwin"))).toMatchObject({
      kind: "launchd",
      installed: true,
      current: true,
      where: plistPath(),
    });
    expect(prWatchScheduleState(opts("darwin", { wrapper: "/moved" }))).toMatchObject({
      installed: true,
      current: false,
    });
  });
});

describe("cron", () => {
  const line =
    "*/10 * * * * PATH='/a\\%b:/usr/bin' '/opt/w m/werkmeister' pr watch >> " +
    `'${path.join("TMP", "cfg", "pr-watch.log")}' 2>&1 ${PR_WATCH_CRON_MARKER}`;
  const expected = () => line.replace("TMP", tmp);

  it("installs exactly one line into an empty crontab", () => {
    const res = installPrWatchSchedule(opts("linux"));
    expect(res.ok).toBe(true);
    expect(crontab).toBe(`${expected()}\n`);
    expect(res.lines.join("\n")).toContain("Logs:");
  });

  it("keeps unrelated lines, in order", () => {
    crontab = "# mine\n0 3 * * * backup\n";
    installPrWatchSchedule(opts("linux"));
    expect(crontab).toBe(`# mine\n0 3 * * * backup\n${expected()}\n`);
  });

  it("stays at one line across reruns and skips the unchanged write", () => {
    installPrWatchSchedule(opts("linux"));
    calls = [];
    const res = installPrWatchSchedule(opts("linux"));
    expect(res.lines[0]).toMatch(/^Already installed/);
    expect(writes()).toEqual([]);
    expect(crontab.split("\n").filter((l) => l.endsWith(PR_WATCH_CRON_MARKER))).toHaveLength(1);
  });

  it("replaces a stale marker line instead of adding a second", () => {
    crontab = `*/10 * * * * old ${PR_WATCH_CRON_MARKER}\n`;
    installPrWatchSchedule(opts("linux"));
    expect(crontab).toBe(`${expected()}\n`);
  });

  it("uninstalls just its line", () => {
    crontab = "0 3 * * * backup\n";
    installPrWatchSchedule(opts("linux"));
    expect(uninstallPrWatchSchedule(opts("linux")).lines).toEqual(["Removed the crontab line."]);
    expect(crontab).toBe("0 3 * * * backup\n");
    expect(uninstallPrWatchSchedule(opts("linux")).lines).toEqual([
      "No PR watch schedule installed.",
    ]);
  });

  it("fails cleanly when crontab is missing", () => {
    const res = installPrWatchSchedule(
      opts("linux", { runner: fakeRunner({ crontab: [127, ""] }) }),
    );
    expect(res).toEqual({ ok: false, lines: ["crontab not found"] });
  });
});

describe("syncPrWatchSchedule", () => {
  it("writes nothing in check mode, even with install", () => {
    const [step] = syncPrWatchSchedule(true, true, opts("linux"));
    expect(writes()).toEqual([]);
    expect(step).toMatchObject({ ok: true });
    expect(step.detail).toMatch(/^not installed \(opt in/);
  });

  it("writes nothing when the person declined", () => {
    const [step] = syncPrWatchSchedule(false, false, opts("darwin"));
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(step.detail).toMatch(/^not installed/);
  });

  it("installs on a yes and reports where and the log path", () => {
    const [step] = syncPrWatchSchedule(false, true, opts("darwin"));
    expect(fs.existsSync(plistPath())).toBe(true);
    expect(step.ok).toBe(true);
    expect(step.detail).toBe(
      `installed (${plistPath()}), logs → ${path.join(tmp, "cfg", "pr-watch.log")}`,
    );
  });

  it("is an optional warning when install fails", () => {
    const runner = fakeRunner({ crontab: [127, ""] });
    const [step] = syncPrWatchSchedule(false, true, opts("linux", { runner }));
    expect(step).toMatchObject({ ok: false, optional: true, detail: "crontab not found" });
  });
});

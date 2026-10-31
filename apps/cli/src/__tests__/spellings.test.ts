/**
 * SW-186: every command's old spelling parses to the args it always did (pinned by
 * the snapshot), and its noun-group spelling parses to the same args.
 *
 * Driven through `__parse`, which stops after commander and prints the command and
 * namespace, so no case touches docker, a workspace or the tracker.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../..");
/** Built by the `test` script; a cold `tsx src/main.ts` per case transpiles the whole CLI each time (#206). */
const MAIN = path.join(CLI_DIR, "dist/main.js");

const run = promisify(execFile);

// Async: 56 sync cases never yield the worker's event loop, and past 60 s vitest's RPC times out.
async function parse(argv: string[]) {
  const res = await run(process.execPath, [MAIN, "__parse", ...argv], { cwd: CLI_DIR });
  return { ...JSON.parse(res.stdout), stderr: res.stderr };
}

// [old argv, new argv]; the same argv twice is a spelling SW-186 kept, which must not warn.
const CASES: [string[], string[]][] = [
  [
    ["up", "f", "--dev", "-w", "/ws"],
    ["feature", "up", "f", "--dev", "-w", "/ws"],
  ],
  [
    ["down", "f", "-v", "--all-features"],
    ["feature", "down", "f", "-v", "--all-features"],
  ],
  [
    ["restart", "f"],
    ["feature", "restart", "f"],
  ],
  [
    ["pause", "f"],
    ["feature", "pause", "f"],
  ],
  [
    ["resume", "f"],
    ["feature", "resume", "f"],
  ],
  [
    ["stop", "f"],
    ["feature", "stop", "f"],
  ],
  [
    ["stop", "f", "--via-daemon"],
    ["feature", "stop", "f", "--via-daemon"],
  ],
  [
    ["stop", "--if-idle", "--via-daemon"],
    ["internal", "session-end", "--via-daemon"],
  ],
  [
    ["stop", "f", "--idle", "30"],
    ["internal", "reap", "30", "f"],
  ],
  [
    ["status", "-v", "--intercepts", "--json"],
    ["feature", "status", "-v", "--intercepts", "--json"],
  ],
  [
    ["status", "--k8s"],
    ["infra", "status"],
  ],
  [
    ["services", "f"],
    ["feature", "services", "f"],
  ],
  [
    ["logs", "f", "api"],
    ["feature", "logs", "f", "api"],
  ],
  [
    ["remove", "f", "api"],
    ["feature", "drop", "f", "api"],
  ],
  [
    ["test", "f", "--scaffold", "--base-url", "https://x"],
    ["feature", "test", "f", "--scaffold", "--base-url", "https://x"],
  ],
  [
    ["open", "f", "--path", "/p"],
    ["feature", "open", "f", "--path", "/p"],
  ],
  [
    ["intercept", "f", "-s", "api", "--leave"],
    ["infra", "intercept", "f", "-s", "api", "--leave"],
  ],
  [
    ["connect", "--k8s"],
    ["infra", "connect", "--k8s"],
  ],
  [["proxy-reload"], ["infra", "proxy-reload"]],
  [
    ["workspace", "f", "--issue-id", "SW-1", "-s", "api,web", "--autonomous"],
    ["ws", "new", "f", "--issue-id", "SW-1", "-s", "api,web", "--autonomous"],
  ],
  [
    ["init-workspace", "--feature", "f", "--refresh-issue"],
    ["workspace", "init", "--feature", "f", "--refresh-issue"],
  ],
  [["list-workspaces"], ["workspace", "list"]],
  [
    ["close-out", "n", "-y"],
    ["workspace", "close", "n", "-y"],
  ],
  [
    ["close-out", "n", "--abandon", "why"],
    ["workspace", "abandon", "why", "n"],
  ],
  [
    ["remove-workspace", "n", "--abandon", "why"],
    ["workspace", "abandon", "why", "n"],
  ],
  [
    ["code", "f"],
    ["workspace", "code", "f"],
  ],
  [
    ["starting-prompt", "--start", "/d"],
    ["workspace", "prompt", "--start", "/d"],
  ],
  [
    ["start-args", "--start", "/d"],
    ["workspace", "prompt", "--args", "--start", "/d"],
  ],
  [
    ["pr", "open", "sandbox", "--no-wait"],
    ["pr", "open", "sandbox", "--no-wait"],
  ],
  [
    ["pr", "adopt", "12", "sandbox"],
    ["pr", "adopt", "12", "sandbox"],
  ],
  [
    ["pr", "adopt", "--no-pr", "on base", "sandbox"],
    ["pr", "adopt", "--no-pr", "on base", "sandbox"],
  ],
  [
    ["pr", "watch", "--install"],
    ["pr", "watch", "--install"],
  ],
  [
    ["pr", "new", "sandbox", "--slug", "s"],
    ["pr", "new", "sandbox", "--slug", "s"],
  ],
  [
    ["issue", "view", "SW-1", "--json"],
    ["issue", "view", "SW-1", "--json"],
  ],
  [
    ["issue", "update", "--status", "Done", "--comment", "c"],
    ["issue", "update", "--status", "Done", "--comment", "c"],
  ],
  [
    ["issue", "create", "--project", "SW", "--type", "bug", "--title", "t"],
    ["issue", "create", "--project", "SW", "--type", "bug", "--title", "t"],
  ],
  [
    ["skills", "check"],
    ["skills", "check"],
  ],
  [
    ["standards", "check"],
    ["standards", "check"],
  ],
  [
    ["notes", "graduate", "3", "--kind", "rule"],
    ["notes", "graduate", "3", "--kind", "rule"],
  ],
  [
    ["hooks", "gate"],
    ["internal", "gate"],
  ],
  [
    ["hooks", "pr-guard"],
    ["internal", "pr-guard"],
  ],
  [
    ["hooks", "agent-state"],
    ["internal", "agent-state"],
  ],
  [["wait-load"], ["internal", "wait-load"]],
  [
    ["setup", "--check"],
    ["machine", "setup", "--check"],
  ],
  [
    ["config", "--check"],
    ["machine", "config", "--check"],
  ],
  [
    ["detect", "r", "--dry-run", "--no-assist"],
    ["machine", "detect", "r", "--dry-run", "--no-assist"],
  ],
  [
    ["migrate", "--check", "--workspaces"],
    ["machine", "migrate", "--check", "--workspaces"],
  ],
  [
    ["clean", "--dry-run"],
    ["machine", "clean", "--dry-run"],
  ],
  [
    ["stats", "--collect", "5"],
    ["machine", "stats", "--collect", "5"],
  ],
  [
    ["optimize", "-i", "3"],
    ["machine", "optimize", "-i", "3"],
  ],
  [
    ["cache", "prune", "pnpm", "--dry-run"],
    ["cache", "prune", "pnpm", "--dry-run"],
  ],
  [
    ["registry", "--check"],
    ["registry", "--check"],
  ],
  [
    ["up", "infra"],
    ["infra", "up"],
  ],
  [
    ["down", "infra", "-v"],
    ["infra", "down", "-v"],
  ],
  [
    ["restart", "infra"],
    ["infra", "restart"],
  ],
  [
    ["stop", "infra"],
    ["infra", "stop"],
  ],
];

describe("command spellings", () => {
  it.each(CASES)("%j", async (oldArgv, newArgv) => {
    const [before, after] = await Promise.all([parse(oldArgv), parse(newArgv)]);
    expect(before.args).toMatchSnapshot();
    expect(after.args).toMatchObject(before.args);
    expect(after.stderr).toBe("");
    if (newArgv.join(" ") === oldArgv.join(" ")) return;
    // One stderr line naming the removal release and the new noun and verb; stdout stays the JSON above.
    expect(before.stderr.trim().split("\n")).toHaveLength(1);
    expect(before.stderr).toMatch(
      new RegExp(
        `removed in \\d+\\.\\d+\\.\\d+; use 'werkmeister ${newArgv[0] === "ws" ? "workspace" : newArgv[0]} ${newArgv[1]}`,
      ),
    );
  });
});

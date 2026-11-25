// SW-404: the structured logger: bindings, level resolution, where lines land, the machine-log cap, stderr, redaction.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { sandboxHome } from "../dist/config.js";
import {
  createLogger,
  logWorkspaceDir,
  MACHINE_LOG_CAP,
  machineLogPath,
  resolveLevel,
  scrub,
  slowCallKind,
  withLogger,
  workspaceLogPath,
} from "../dist/logger.js";
import { error as reporterError, warn as reporterWarn } from "../dist/reporter.js";

// These tests overwrite secrets.env and the machine log, so they get a HOME of their own whatever runs them:
// a direct `node --test` or a set WERKMEISTER_CONFIG_FILE must never reach the real ~/.werkmeister.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sw404-home-"));
process.env.HOME = home;
delete process.env.WERKMEISTER_CONFIG_FILE;
if (!sandboxHome().startsWith(home))
  throw new Error(`sandboxHome ${sandboxHome()} is not under ${home}`);
after(() => fs.rmSync(home, { recursive: true, force: true }));
// This file's own process: a caller's level must not change what the default-level tests see.
delete process.env.WERKMEISTER_LOG_LEVEL;

fs.mkdirSync(sandboxHome(), { recursive: true });
/** A workspace folder: a log line goes only into a `.werkmeister/` that exists. */
const tmpWs = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sw404-ws-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  return ws;
};
const readLines = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// First: the cap is checked once per file per process, at its first write.
test("the machine log over the cap moves to .1 at its first write, replacing an older .1", () => {
  const file = machineLogPath();
  const old = file.replace(/\.jsonl$/, ".1.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(old, "stale\n");
  fs.writeFileSync(file, "x".repeat(MACHINE_LOG_CAP + 1));
  createLogger({ pid: 1 }, { stderr: false }).error("after the cap");
  assert.equal(fs.statSync(old).size, MACHINE_LOG_CAP + 1, "the full file became .1");
  assert.deepEqual(
    readLines(file).map((l) => l.msg),
    ["after the cap"],
  );
});

test("machine and workspace logs are under the temp HOME and the workspace", () => {
  assert.ok(process.env.HOME && machineLogPath().startsWith(process.env.HOME));
  assert.ok(sandboxHome().startsWith(process.env.HOME));
  const ws = tmpWs();
  createLogger({ pid: 1 }, { workspaceDir: ws, stderr: false }).error("ws line");
  assert.equal(workspaceLogPath(ws), path.join(ws, ".werkmeister", "logs", "werkmeister.jsonl"));
  assert.deepEqual(
    readLines(workspaceLogPath(ws)).map((l) => l.msg),
    ["ws line"],
  );
});

test("every line carries the bindings, a text level, an ISO time and err's stack and code", () => {
  const ws = tmpWs();
  const b = {
    app: "cli",
    workspace: "sw-1-x",
    run_id: "run-1",
    ticket: "SW-1",
    command: "feature up",
    stage: "02_spec",
    pid: 42,
    version: "1.2.3",
    commit: "abc1234",
  };
  const err = Object.assign(new Error("boom"), { code: "E_BOOM" });
  createLogger(b, { workspaceDir: ws, stderr: false }).error({ err }, "command failed");
  const [line] = readLines(workspaceLogPath(ws));
  for (const [k, v] of Object.entries(b)) assert.equal(line[k], v, k);
  assert.equal(line.level, "error");
  assert.ok(!Number.isNaN(Date.parse(line.time)));
  assert.equal(line.err.message, "boom");
  assert.equal(line.err.code, "E_BOOM");
  assert.match(line.err.stack, /Error: boom/);
});

test("resolveLevel: default error; env or flag (flag wins) lower it to trace; a bad value is error", () => {
  assert.deepEqual(resolveLevel(undefined, undefined), { level: "error", explicit: false });
  for (const l of ["error", "warn", "info", "debug", "trace"])
    assert.deepEqual(resolveLevel(undefined, l), { level: l, explicit: true });
  assert.deepEqual(resolveLevel("debug", "info"), { level: "debug", explicit: true });
  assert.deepEqual(resolveLevel(undefined, "INFO"), { level: "info", explicit: true });
  assert.deepEqual(resolveLevel("bogus", undefined), {
    level: "error",
    explicit: false,
    invalid: "bogus",
  });
});

test("at the default level, warn and info are dropped and error is written", () => {
  const ws = tmpWs();
  const log = createLogger({ pid: 1 }, { workspaceDir: ws, stderr: false });
  log.info("quiet");
  log.warn("quiet too");
  assert.equal(fs.existsSync(workspaceLogPath(ws)), false, "no line, no file");
  log.error("loud");
  assert.deepEqual(
    readLines(workspaceLogPath(ws)).map((l) => [l.level, l.msg]),
    [["error", "loud"]],
  );
});

test("lines reach stderr only when asked", () => {
  const ws = tmpWs();
  const seen = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (seen.push(String(chunk)), true);
  try {
    createLogger({ pid: 1 }, { workspaceDir: ws, stderr: false }).error("file only");
    createLogger({ pid: 1 }, { workspaceDir: ws, stderr: true }).error("both");
  } finally {
    process.stderr.write = write;
  }
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0]).msg, "both");
  assert.equal(readLines(workspaceLogPath(ws)).length, 2);
});

test("redaction: fields, secrets.env values, secret-named env values and token shapes never reach the file", () => {
  const ws = tmpWs();
  const fromFile = "file-secret-value-1234";
  fs.mkdirSync(sandboxHome(), { recursive: true });
  fs.writeFileSync(path.join(sandboxHome(), "secrets.env"), `JIRA_API_TOKEN="${fromFile}"\n`);
  const fromEnv = "env-secret-value-5678";
  process.env.SW404_TEST_TOKEN = fromEnv;
  process.env.SW404_SHORT_KEY = "abc"; // under 8 characters: not treated as a secret
  const gh = `ghp_${"a".repeat(36)}`;
  const aws = "AKIAABCDEFGHIJKLMNOP";
  const appToken = `ghs_${"b".repeat(36)}`;
  const log = createLogger({ pid: 1 }, { workspaceDir: ws, stderr: false });
  const cases = [
    ["field token", { token: "plain-field-token" }, "plain-field-token"],
    ["nested token", { creds: { token: "nested-field-token" } }, "nested-field-token"],
    ["headers", { headers: { authorization: "hdr-secret-123" } }, "hdr-secret-123"],
    ["nested headers", { req: { headers: { authorization: "hdr-secret-456" } } }, "hdr-secret-456"],
    ["secrets.env value", { detail: `got ${fromFile} back` }, fromFile],
    ["env value", { err: new Error(`auth failed for ${fromEnv}`) }, fromEnv],
    ["stderr tail", { stderrTail: `fatal: ${gh} rejected` }, gh],
    ["aws key", { detail: `key ${aws}` }, aws],
    ["GitHub App installation token (SW-584)", { detail: `GH_TOKEN=${appToken}` }, appToken],
    ["bearer", { detail: "Authorization: Bearer abc.def-ghi" }, "abc.def-ghi"],
    ["basic", { detail: "Basic dXNlcjpwYXNzd29yZDEyMzQ=" }, "dXNlcjpwYXNzd29yZDEyMzQ="],
  ];
  for (const [msg, obj] of cases) log.error(obj, msg);
  log.error({ detail: "short abc stays" }, "short value");
  const text = fs.readFileSync(workspaceLogPath(ws), "utf8");
  const lines = readLines(workspaceLogPath(ws));
  for (const [msg, , secret] of cases) {
    // The line was written (the path ran), and holds the marker, never the secret.
    const line = lines.find((l) => l.msg === msg);
    assert.ok(line, `${msg}: logged`);
    assert.match(JSON.stringify(line), /\[redacted\]/, msg);
    assert.equal(text.includes(secret), false, `${msg}: ${secret} leaked`);
  }
  assert.match(text, /short abc stays/);
  assert.equal(scrub(`x ${fromEnv} y`), "x [redacted] y");
  delete process.env.SW404_TEST_TOKEN;
  delete process.env.SW404_SHORT_KEY;
});

test("slowCallKind maps the tracked external calls and nothing else", () => {
  assert.equal(slowCallKind("docker", ["build", "-t", "x", "."]), "docker build");
  assert.equal(
    slowCallKind("/usr/bin/docker", ["compose", "-f", "c.yml", "build"]),
    "docker build",
  );
  assert.equal(slowCallKind("pnpm", ["install", "--frozen-lockfile"]), "install");
  assert.equal(slowCallKind("npm", ["install"]), "install");
  assert.equal(slowCallKind("git", ["-C", "/r", "fetch", "-q", "origin"]), "git fetch");
  assert.equal(slowCallKind("git", ["status"]), null);
  assert.equal(slowCallKind("docker", ["ps"]), null);
});

test("the reporter's warn and error also reach the ambient logger, marked source: reporter", async () => {
  const ws = tmpWs();
  const log = createLogger({ pid: 1 }, { workspaceDir: ws, level: "warn", stderr: false });
  await withLogger(log, async () => {
    reporterWarn("seen warn");
    reporterError("seen error");
  });
  assert.deepEqual(
    readLines(workspaceLogPath(ws)).map((l) => [l.level, l.msg, l.source]),
    [
      ["warn", "seen warn", "reporter"],
      ["error", "seen error", "reporter"],
    ],
  );
});

test("a command logs to the cwd's workspace unless it names another one", () => {
  const ws = "/ws/sw-1-a";
  assert.equal(logWorkspaceDir(undefined, {}), undefined, "outside a workspace: the machine log");
  assert.equal(logWorkspaceDir(ws, {}), ws);
  assert.equal(logWorkspaceDir(ws, { feature: "sw-1-a" }), ws, "naming its own workspace");
  assert.equal(logWorkspaceDir(ws, { workspace: "/ws/sw-1-a" }), ws, "a path to it");
  assert.equal(logWorkspaceDir(ws, { name: "sw-2-b" }), undefined, "workspace close sw-2-b from a");
  assert.equal(logWorkspaceDir(ws, { feature: "sw-2-b" }), undefined, "feature up sw-2-b from a");
  assert.equal(logWorkspaceDir(ws, { feature: "" }), ws, "an empty value names nothing");
});

test("a line never creates a workspace: a removed one falls back to the machine log", () => {
  const gone = path.join(os.tmpdir(), `sw404-gone-${process.pid}`);
  createLogger({ pid: 1, workspace: "gone" }, { workspaceDir: gone, stderr: false }).error(
    "after close-out",
  );
  assert.equal(fs.existsSync(gone), false, "no folder recreated");
  assert.ok(
    readLines(machineLogPath()).some((l) => l.msg === "after close-out" && l.workspace === "gone"),
  );
});

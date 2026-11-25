/**
 * Structured diagnostics (SW-404): JSON lines through Pino, to `<ws>/.werkmeister/logs/werkmeister.jsonl`
 * inside a workspace and `~/.werkmeister/logs/werkmeister.jsonl` otherwise. Timings are not here: they go
 * through the metrics event log (metrics.ts). Default level `error`; `WERKMEISTER_LOG_LEVEL` or
 * `--log-level` lowers it and also copies lines to stderr. Never stdout: the MCP server's stdout is its
 * JSON-RPC transport.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";

import pino from "pino";

import { sandboxHome } from "./config.js";
import { dotDir, logsDir } from "./dot_dir.js";
import { setLogTee } from "./reporter.js";

export type Level = "error" | "warn" | "info" | "debug" | "trace";
export type Logger = pino.Logger;

const LEVELS: readonly Level[] = ["error", "warn", "info", "debug", "trace"];

export interface LogBindings {
  app: "cli" | "mcp" | "daemon";
  workspace?: string;
  /** The workspace run's id (SW-1140), so a reused name's earlier run is told apart at close-out. */
  run_id?: string;
  ticket?: string;
  /** CLI `noun verb`, or the MCP tool name. */
  command?: string;
  stage?: string;
  pid: number;
  version?: string;
  commit?: string;
}

/** `--log-level` wins over `WERKMEISTER_LOG_LEVEL`; *explicit* when either names a valid level. */
export function resolveLevel(
  flag?: string,
  env = process.env["WERKMEISTER_LOG_LEVEL"],
): { level: Level; explicit: boolean; invalid?: string } {
  const asked = (flag ?? env)?.trim().toLowerCase();
  if (!asked) return { level: "error", explicit: false };
  if ((LEVELS as readonly string[]).includes(asked))
    return { level: asked as Level, explicit: true };
  return { level: "error", explicit: false, invalid: flag ?? env };
}

export const MACHINE_LOG_CAP = 10 * 1024 * 1024;

export const machineLogPath = () => path.join(sandboxHome(), "logs", "werkmeister.jsonl");
export const workspaceLogPath = (ws: string) => path.join(logsDir(ws), "werkmeister.jsonl");

const ENV_SECRET = /(_TOKEN|_KEY|_SECRET|PASSWORD)$/;
const TOKEN_PATTERNS = [
  /gh[pos]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer [A-Za-z0-9._~+/=-]+/g,
  /Basic [A-Za-z0-9+/=]{16,}/g,
];

/** Values to scrub: each non-empty `secrets.env` value, and secret-named env values of 8+ characters. Read per call: lines are rare at the default level, and the file can change under a long-lived daemon. */
export function secretValues(): string[] {
  const out = new Set<string>();
  try {
    for (const raw of fs
      .readFileSync(path.join(sandboxHome(), "secrets.env"), "utf8")
      .split("\n")) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(raw);
      const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (v) out.add(v);
    }
  } catch {}
  for (const [k, v] of Object.entries(process.env))
    if (v && v.length >= 8 && ENV_SECRET.test(k)) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}

/** *line* with every secret value (raw and JSON-escaped) and known token shape replaced by `[redacted]`. */
export function scrub(line: string): string {
  let out = line;
  for (const v of secretValues())
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1)]))
      out = out.split(form).join("[redacted]");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

const REDACT_PATHS = [
  "token",
  "password",
  "secret",
  "apiKey",
  "authorization",
  "env",
  "*.token",
  "*.apiToken",
  "*.password",
  "*.secret",
  "*.apiKey",
  "*.authorization",
  "*.Authorization",
  "headers.cookie",
  "headers.authorization",
  "*.headers.authorization",
];

const capped = new Set<string>();
let warnedWrite = false;

/**
 * Where a line goes. `logs/` is only ever made inside a `.werkmeister/` that exists, so a line never creates a
 * workspace or a home: not a workspace close-out just removed, nor a test's made-up HOME. A workspace that is
 * gone falls back to the machine log; with no `~/.werkmeister` either, the line is dropped.
 */
function target(workspaceDir: string | undefined): { file: string; cap: boolean } | null {
  if (workspaceDir && fs.existsSync(dotDir(workspaceDir)))
    return { file: workspaceLogPath(workspaceDir), cap: false };
  return fs.existsSync(sandboxHome()) ? { file: machineLogPath(), cap: true } : null;
}

/** Appends one line; never throws, since a lost log line must not fail the command that logged it. */
function appendLine(file: string, line: string, cap: boolean): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (cap && !capped.has(file)) {
      capped.add(file);
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MACHINE_LOG_CAP)
        fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
    }
    // One appendFileSync is one write() on an O_APPEND file, so concurrent writers' lines don't interleave.
    fs.appendFileSync(file, line);
  } catch (e) {
    if (!warnedWrite)
      console.error(`werkmeister: could not write log ${file}: ${(e as Error).message}`);
    warnedWrite = true;
  }
}

/** A logger bound to *b*: its file is the workspace's when *workspaceDir* is given, else the machine log (capped). */
export function createLogger(
  b: Partial<LogBindings> & { pid: number },
  opts: { workspaceDir?: string; level?: Level; stderr?: boolean } = {},
): Logger {
  const resolved = resolveLevel();
  const stderr = opts.stderr ?? resolved.explicit;
  const stream = {
    write(line: string) {
      const clean = scrub(line);
      const to = target(opts.workspaceDir);
      if (to) appendLine(to.file, clean, to.cap);
      if (stderr) process.stderr.write(clean);
    },
  };
  const base = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
  return pino(
    {
      level: opts.level ?? resolved.level,
      base,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    stream,
  );
}

/** The machine-wide logger, for code that runs outside any {@link withLogger}. */
export const logger: Logger = createLogger({ pid: process.pid });

const storage = new AsyncLocalStorage<Logger>();

export function withLogger<T>(log: Logger, fn: () => Promise<T>): Promise<T> {
  return storage.run(log, fn);
}

export function currentLogger(): Logger {
  return storage.getStore() ?? logger;
}

setLogTee((level, msg) => currentLogger()[level]({ source: "reporter" }, msg));

/**
 * The workspace a command's log belongs to: the cwd's (*cwdWorkspace*), unless the command names another one by
 * `workspace`, `feature` or `name`. Then none, so its lines go to the machine log rather than onto the cwd
 * workspace's record.
 */
export function logWorkspaceDir(
  cwdWorkspace: string | undefined,
  args: Record<string, unknown>,
): string | undefined {
  if (!cwdWorkspace) return undefined;
  const named = [args["workspace"], args["feature"], args["name"]].filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  return named.every((n) => path.basename(n) === path.basename(cwdWorkspace))
    ? cwdWorkspace
    : undefined;
}

/** The `call.slow` kind of an external call, or null when it is not one the metrics board tracks. */
export function slowCallKind(
  bin: string,
  args: readonly string[],
): "docker build" | "install" | "git fetch" | null {
  const name = path.basename(bin);
  if (name === "docker" && args.includes("build")) return "docker build";
  if ((name === "pnpm" || name === "npm") && args.includes("install")) return "install";
  if (name === "git" && args.includes("fetch")) return "git fetch";
  return null;
}

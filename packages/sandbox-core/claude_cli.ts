/**
 * The local `claude` CLI as a subprocess: locating it under Claude Desktop's
 * minimal PATH, running `claude -p`, and pulling a tagged result or a JSON
 * object out of what it prints. Shared by sandbox.ts and the issue trackers
 * (whose Atlassian-MCP fallback is a `claude -p` run).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SandboxError, WORKSPACE_ERROR_CODE } from "./errors.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Env for a child `sandbox` process. The wrapper has to find a `node` runtime
 * (and `docker`, `git`, `gh` downstream of it), which the stripped PATH a
 * GUI-launched process inherits often can't — prepend the usual tool dirs.
 *
 * Exported for the same reason as {@link resolveSandboxBin}: callers that spawn
 * the CLI themselves need this env, not a hand-rolled approximation of it.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const extra = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const merged = [...new Set([...extra, ...current])].join(path.delimiter);
  return { ...process.env, PATH: merged };
}

/**
 * Locate the `claude` CLI, robust to Claude Desktop's minimal PATH. Order:
 * $CLAUDE_BIN → the usual install locations → bare `claude` (resolved against
 * the augmented PATH in {@link childEnv}).
 */
export async function resolveClaudeBin(): Promise<string> {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return "claude"; // Node resolves this against childEnv().PATH below.
}

/**
 * Run a binary, capturing stdout/stderr, with stdin CLOSED so `claude -p`
 * doesn't stall 3s waiting for piped input. Rejects on spawn error or timeout.
 */
export function runCapture(
  bin: string,
  args: string[],
  cwd: string = os.homedir(),
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SandboxError("The `claude` CLI timed out after 120s.", WORKSPACE_ERROR_CODE));
    }, 120_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Pull the rewrite out of the model's tagged output; fall back to the whole text. */
export function extractResult(out: string): string {
  const m = out.match(/<result>\s*([\s\S]*?)\s*<\/result>/i);
  return (m ? m[1] : out).trim();
}

/**
 * Slice a `{…}` (possibly fenced) JSON object out of free-form model output.
 * The outermost braces win when they parse, so a fence inside a JSON string
 * value (a starting prompt with a ```bash block) isn't mistaken for the answer.
 */
export function extractJson(out: string): string | null {
  const slice = (s: string): string | null => {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    return start !== -1 && end > start ? s.slice(start, end + 1) : null;
  };
  const whole = slice(out);
  if (whole) {
    try {
      JSON.parse(whole);
      return whole;
    } catch {
      // fall through to a fenced block
    }
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(out);
  return fenced ? slice(fenced[1]) : whole;
}

/**
 * One `claude -p` run, the tagged `<result>` body or null on any failure.
 * `tools` adds --dangerously-skip-permissions: the Atlassian MCP tools are
 * deferred, so --allowedTools cannot pre-approve them in headless mode.
 */
export async function askClaude(prompt: string, opts: { tools?: boolean } = {}): Promise<string | null> {
  try {
    const args = opts.tools ? ["-p", prompt, "--dangerously-skip-permissions"] : ["-p", prompt];
    const res = await runCapture(await resolveClaudeBin(), args);
    if (res.code !== 0) return null;
    return extractResult(stripAnsi(res.stdout));
  } catch {
    return null;
  }
}

/** {@link askClaude}, then the JSON object in its answer; null when there is none. */
export async function askClaudeJson(prompt: string, opts: { tools?: boolean } = {}): Promise<Record<string, unknown> | null> {
  const out = await askClaude(prompt, opts);
  const json = out === null ? null : extractJson(out);
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

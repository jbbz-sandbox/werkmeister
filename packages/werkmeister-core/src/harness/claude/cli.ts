/**
 * The local `claude` CLI as a subprocess: locating it under Claude Desktop's
 * minimal PATH, running `claude -p`, and pulling a tagged result or a JSON
 * object out of what it prints. Shared by sandbox.ts and the issue trackers
 * (whose Atlassian-MCP fallback is a `claude -p` run).
 */
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "../../errors.js";
import { isExecutable, runCapture, shellQuote, stripAnsi } from "../../tool_bins.js";

/**
 * Locate the `claude` CLI, robust to Claude Desktop's minimal PATH. Order:
 * $CLAUDE_BIN → the usual install locations → bare `claude` (resolved against
 * the augmented PATH in {@link childEnv} (tool_bins.ts)).
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
export async function askClaude(
  prompt: string,
  opts: { tools?: boolean } = {},
): Promise<string | null> {
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
export async function askClaudeJson(
  prompt: string,
  opts: { tools?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const out = await askClaude(prompt, opts);
  const json = out === null ? null : extractJson(out);
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * {@link askClaude} for a caller that reports why it failed: the `<result>`
 * body, or a WorkspaceError naming a missing CLI, a non-zero exit or no text.
 */
export async function askClaudeStrict(prompt: string): Promise<string> {
  const bin = await resolveClaudeBin();
  let res: { stdout: string; stderr: string; code: number | null };
  try {
    res = await runCapture(bin, ["-p", prompt]);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "ENOENT") {
      throw new WorkspaceError(
        "Could not find the `claude` CLI. Set CLAUDE_BIN to its path, or install Claude Code.",
      );
    }
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError(`Refine via claude failed: ${err.message ?? String(e)}`);
  }
  if (res.code !== 0) {
    const detail = stripAnsi((res.stderr || res.stdout || "").trim());
    throw new WorkspaceError(`claude exited with code ${res.code}:\n${detail}`);
  }
  const out = extractResult(stripAnsi(res.stdout));
  if (!out) throw new WorkspaceError("Claude returned no text.");
  return out;
}

/** The Terminal command line that starts a PR-reconcile session in *dir*. */
export function reconcileCommand(dir: string, ctxFile: string, prompt: string): string {
  // SECURITY: the system prompt is built from third-party content (the PR
  // author's title/body/diff, the issue description), so this must NOT run with
  // --dangerously-skip-permissions — that would turn a prompt-injection payload
  // in the PR into arbitrary command execution on the host. Instead:
  //   • `-p` (headless) skips the folder-trust dialog the fresh dir would
  //     otherwise stall on (documented behaviour) — which is the ONLY thing we
  //     needed a bypass for, since the diff is embedded and the analysis turn
  //     calls no tools. Headless mode also can't prompt, so any tool a payload
  //     tries to invoke is DENIED rather than auto-approved (verified: a planted
  //     "run bash" payload was refused and executed nothing).
  //   • --disallowedTools hard-blocks the write/exec surface as defence in depth.
  // NOT --bare: it skips keychain reads, which leaves the session unauthenticated
  // ("Please run /login"). We lose --bare's leanness to keep working auth.
  // The browser chat continues the session via `claude-send` (also `-p --resume`).
  return (
    `cd ${shellQuote(dir)} && claude -p --disallowedTools Bash Edit Write ` +
    `--append-system-prompt-file ${shellQuote(ctxFile)} ${shellQuote(prompt)}`
  );
}

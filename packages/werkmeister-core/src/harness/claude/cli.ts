/**
 * The local `claude` CLI: locating it under Claude Desktop's minimal PATH and
 * asking it one question through the Agent SDK, answered as structured output
 * (SW-386). Shared by sandbox.ts and the issue trackers (whose Atlassian-MCP
 * fallback is a tools-enabled run).
 */

import os from "node:os";
import path from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { isFixture } from "../../config.js";
import { WorkspaceError } from "../../errors.js";
import { childEnv, fixtureClaudeBin, isExecutable, shellQuote } from "../../tool_bins.js";

/**
 * Locate the `claude` CLI, robust to Claude Desktop's minimal PATH. Order:
 * $CLAUDE_BIN → the usual install locations → bare `claude` (resolved against
 * the augmented PATH in `childEnv` (tool_bins.ts)).
 */
export async function resolveClaudeBin(): Promise<string> {
  if (isFixture()) return fixtureClaudeBin();
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

type AskOpts = { tools?: boolean };

/** `ask`'s answer as one string field: no tag scraping. */
const TEXT_SCHEMA = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
};

/**
 * One Agent SDK run of *prompt* on the user's own `claude` (their auth, settings,
 * plugins and MCP servers), from $HOME so a project's files can't leak in, capped
 * at 120 s like runCapture was. `tools` is the old --dangerously-skip-permissions:
 * the Atlassian MCP tools are deferred, so an allow-list cannot pre-approve them
 * headless. Without it the model holds no tools at all.
 */
async function runQuery(
  prompt: string,
  schema: Record<string, unknown>,
  opts: AskOpts,
): Promise<SDKResultMessage> {
  // Loaded on use: the MCP server imports this module at start, and the SDK is heavy.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120_000);
  try {
    for await (const m of query({
      prompt,
      options: {
        cwd: os.homedir(),
        pathToClaudeCodeExecutable: await resolveClaudeBin(),
        env: childEnv(),
        abortController,
        outputFormat: { type: "json_schema", schema },
        ...(opts.tools
          ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
          : { tools: [] }),
      },
    })) {
      if (m.type === "result") return m;
    }
    throw new WorkspaceError("the Claude session ended without a result");
  } catch (e) {
    if (abortController.signal.aborted)
      throw new WorkspaceError("The `claude` CLI timed out after 120s.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The structured answer in a result message, or the WorkspaceError that says why there is none. */
export function fromResult(m: SDKResultMessage): Record<string, unknown> {
  if (m.subtype !== "success")
    throw new WorkspaceError(`claude ended with ${m.subtype}:\n${m.errors.join("\n")}`);
  // "Not logged in", an API outage: a success-shaped result with the reason in `result`.
  if (m.is_error) throw new WorkspaceError(`claude ended with an error:\n${m.result}`);
  if (!m.structured_output || typeof m.structured_output !== "object")
    throw new WorkspaceError("Claude returned no text.");
  return m.structured_output as Record<string, unknown>;
}

/** One run, the answer or null on any failure. */
export function askClaude(prompt: string, opts: AskOpts = {}): Promise<string | null> {
  return askClaudeStrict(prompt, opts).catch(() => null);
}

/** {@link askClaude} with a JSON object as the answer; null when there is none. */
export async function askClaudeJson(
  prompt: string,
  opts: AskOpts = {},
): Promise<Record<string, unknown> | null> {
  try {
    return fromResult(await runQuery(prompt, { type: "object" }, opts));
  } catch {
    return null;
  }
}

/**
 * {@link askClaude} for a caller that reports why it failed: the answer, or a
 * WorkspaceError naming a missing CLI, the result's error subtype or no text.
 */
export async function askClaudeStrict(prompt: string, opts: AskOpts = {}): Promise<string> {
  let res: SDKResultMessage;
  try {
    res = await runQuery(prompt, TEXT_SCHEMA, opts);
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    const err = e as { message?: string };
    if (/not found/i.test(err.message ?? ""))
      throw new WorkspaceError(
        "Could not find the `claude` CLI. Set CLAUDE_BIN to its path, or install Claude Code.",
      );
    throw new WorkspaceError(`Refine via claude failed: ${err.message ?? String(e)}`);
  }
  // The prompts still ask for <result> tags; a model that writes them into the field loses nothing.
  const out = extractResult(String(fromResult(res).result ?? ""));
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

/**
 * The local `codex` CLI (SW-384): locating it, and asking it one question through
 * `codex exec`, answered as structured output (`--output-schema`, read back from
 * `-o`), never scraped from stdout.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isFixture } from "../../config.js";
import { WorkspaceError } from "../../errors.js";
import { childEnv, fixtureCodexBin, isExecutable, shellQuote, stripAnsi } from "../../tool_bins.js";
import { extractJson, extractResult } from "../claude/cli.js";

const execFileAsync = promisify(execFile);

/** $CODEX_BIN → the usual install locations → bare `codex` (resolved against `childEnv`'s PATH). */
export async function resolveCodexBin(): Promise<string> {
  if (isFixture()) return fixtureCodexBin();
  const candidates = [
    process.env.CODEX_BIN,
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return "codex";
}

// Codex sends the schema in strict mode: every object needs `additionalProperties: false`
// and fixed properties, so a free-form JSON answer travels as a string in `result`.
const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};

type AskOpts = { tools?: boolean };

/**
 * One `codex exec` of *prompt* on the user's own `codex` (their auth and config), from
 * $HOME so a project's files can't leak in, capped at 120 s like the Claude side.
 * Always read-only: `tools` is accepted for the interface, but MCP tools on Codex run
 * under each server's own approval mode, never with approvals bypassed (SW-384 review).
 */
async function runExec(prompt: string, _opts: AskOpts): Promise<string> {
  const bin = await resolveCodexBin();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "werkmeister-codex-ask-"));
  const schema = path.join(tmp, "schema.json");
  const out = path.join(tmp, "out.json");
  try {
    await fs.writeFile(schema, JSON.stringify(RESULT_SCHEMA));
    const run = execFileAsync(
      bin,
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-C",
        os.homedir(),
        "--output-schema",
        schema,
        "-o",
        out,
        "-s",
        "read-only",
        "--",
        prompt,
      ],
      { env: childEnv(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    // `codex exec` reads stdin to its end before it runs; an open pipe hangs it to the timeout.
    run.child.stdin?.end();
    await run;
    let parsed: { result?: unknown };
    try {
      parsed = JSON.parse(await fs.readFile(out, "utf-8"));
    } catch {
      throw new WorkspaceError("Codex returned no text.");
    }
    return String(parsed.result ?? "");
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    const err = e as { code?: string | number; killed?: boolean; signal?: string; stderr?: string };
    if (err.code === "ENOENT")
      throw new WorkspaceError(
        "Could not find the `codex` CLI. Set CODEX_BIN to its path, or install Codex.",
      );
    if (err.killed || err.signal === "SIGTERM")
      throw new WorkspaceError("The `codex` CLI timed out after 120s.");
    const detail = stripAnsi(String(err.stderr ?? ""))
      .trim()
      .split("\n")
      .slice(-2)
      .join(" ");
    throw new WorkspaceError(`codex exec failed${detail ? `: ${detail}` : ""}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** The answer, or a WorkspaceError naming a missing CLI, a timeout, the exit or no text. */
export async function askCodexStrict(prompt: string, opts: AskOpts = {}): Promise<string> {
  // The prompts ask for <result> tags; a model that writes them into the field loses nothing.
  const out = extractResult(await runExec(prompt, opts));
  if (!out) throw new WorkspaceError("Codex returned no text.");
  return out;
}

export function askCodex(prompt: string, opts: AskOpts = {}): Promise<string | null> {
  return askCodexStrict(prompt, opts).catch(() => null);
}

/** The JSON object Codex returned in `result`; null when there is none. */
export async function askCodexJson(
  prompt: string,
  opts: AskOpts = {},
): Promise<Record<string, unknown> | null> {
  try {
    const json = extractJson(await runExec(prompt, opts));
    const value = json ? JSON.parse(json) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The Terminal command line that starts a PR-reconcile session in *dir*. */
export function codexReconcileCommand(dir: string, ctxFile: string, prompt: string): string {
  // SECURITY: the context holds third-party PR text. `-s read-only` and `exec`'s
  // never-approve policy stop it writing or running commands; it can still read files and
  // call the MCP servers in ~/.codex/config.toml, as the Claude version can read.
  return (
    `cd ${shellQuote(dir)} && codex exec --skip-git-repo-check -s read-only -- ` +
    `"$(cat ${shellQuote(ctxFile)})"$'\\n\\n'${shellQuote(prompt)}`
  );
}

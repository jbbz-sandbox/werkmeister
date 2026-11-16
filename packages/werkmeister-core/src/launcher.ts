/**
 * Which app opens an interactive Claude session: macOS Terminal, or a
 * VS Code integrated terminal through the werkmeister extension's URI handler.
 * Pure: the `open`/osascript calls stay in sandbox.ts.
 */

/**
 * Where an interactive Claude session opens: `"terminal"` for a macOS Terminal
 * window, `"vscode"` for a VS Code terminal (through the werkmeister VS Code
 * extension). When you pass none, werkmeister picks the one you are running
 * in; the `WERKMEISTER_LAUNCHER` environment variable overrides that.
 *
 * @example
 * ```ts
 * import { type Launcher, resumeClaudeInTerminal } from "werkmeister-core/sdk";
 *
 * const where: Launcher = "vscode";
 * const opened = await resumeClaudeInTerminal("my-workspace", undefined, false, undefined, where);
 * console.log(opened.launcher);
 * ```
 */
export type Launcher = "terminal" | "vscode";

/** `WERKMEISTER_LAUNCHER` wins (unknown values ignored); else the caller's own terminal; else Terminal.app. */
export function claudeLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
  const forced = env.WERKMEISTER_LAUNCHER;
  if (forced === "vscode" || forced === "terminal") return forced;
  // The Claude Code VS Code extension sets no TERM_PROGRAM, only this (SW-409).
  if (env.CLAUDE_CODE_ENTRYPOINT === "claude-vscode") return "vscode";
  return env.TERM_PROGRAM === "vscode" ? "vscode" : "terminal";
}

/** The extension id is `JBBZ.werkmeister-vscode`; VS Code matches URI authorities case-insensitively. */
export const VSCODE_URI_BASE = "vscode://jbbz.werkmeister-vscode";

/** The model is not in the URI: the workspace's `.claude/settings.json` already carries it. */
export function claudeLaunchUri(o: {
  workspace: string;
  sessionId: string | null;
  prompt?: string;
}): string {
  const q = new URLSearchParams({ workspace: o.workspace, mode: o.sessionId ? "resume" : "new" });
  if (o.sessionId) q.set("session", o.sessionId);
  if (o.prompt) q.set("prompt", o.prompt);
  return `${VSCODE_URI_BASE}/claude?${q}`;
}

export function reconcileLaunchUri(slug: string): string {
  return `${VSCODE_URI_BASE}/reconcile?${new URLSearchParams({ slug })}`;
}

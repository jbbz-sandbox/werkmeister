/**
 * Which app opens an interactive Claude session (SW-195): macOS Terminal, or a
 * VS Code integrated terminal through the werkmeister extension's URI handler.
 * Pure: the `open`/osascript calls stay in sandbox.ts.
 */

export type Launcher = "terminal" | "vscode";

/** `WERKMEISTER_LAUNCHER` wins (unknown values ignored); else the caller's own terminal; else Terminal.app. */
export function claudeLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
  const forced = env.WERKMEISTER_LAUNCHER;
  if (forced === "vscode" || forced === "terminal") return forced;
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

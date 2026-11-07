/**
 * Parse `vscode://jbbz.werkmeister-vscode/<claude|reconcile>?…` (SW-195), the
 * URI werkmeister-core's `launcher.ts` builds. No `vscode` import, so `node --test`
 * covers it. A URI is untrusted input (any app or page can open one): only a
 * workspace *name* and a reconcile *slug* are accepted, never a path or a command.
 * The Remote Control name is the matched workspace's, never the query's (SW-499).
 */

/** POSIX single-quote escaping — the integrated terminal is a shell, not execFile. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type Launch =
  | { kind: "claude"; workspace: string; command: string }
  | { kind: "reconcile"; slug: string };

const SESSION_RE = /^[\w-]+$/;
// `<repo>-<number>`, as core's launchPrReconcile names the dir.
const SLUG_RE = /^[\w.-]+-\d+$/;

export type SessionMode = "new" | "continue" | "resume";

/**
 * The terminal command that opens a session of *harness* (SW-384). *codexLaunch* is core's
 * `CODEX_LAUNCH`, passed in so this file stays free of werkmeister-core for its tests.
 */
export function sessionCommand(
  harness: string,
  mode: SessionMode,
  session = "",
  codexLaunch = "codex",
): string {
  if (harness === "codex") {
    if (mode === "new") return codexLaunch;
    return `${codexLaunch} resume ${mode === "continue" ? "--last" : session}`;
  }
  if (mode === "new") return "claude";
  return mode === "continue" ? "claude --continue" : `claude --resume ${session}`;
}

/**
 * *harness* is the workspace's, looked up by the caller (the URI path stays `/claude` for every harness).
 * *matchedName* is the name of the workspace the caller found for the query, if any.
 */
export function parseLaunchUri(
  uriPath: string,
  query: string,
  harness = "claude",
  codexLaunch = "codex",
  matchedName?: string,
): Launch {
  const q = new URLSearchParams(query);
  if (uriPath === "/reconcile") {
    const slug = q.get("slug") ?? "";
    if (!SLUG_RE.test(slug)) throw new Error(`Bad reconcile slug: ${JSON.stringify(slug)}`);
    return { kind: "reconcile", slug };
  }
  if (uriPath !== "/claude") throw new Error(`Unknown werkmeister URI path: ${uriPath}`);
  const workspace = q.get("workspace") ?? "";
  if (!workspace) throw new Error("Missing workspace name");
  const mode = q.get("mode");
  const session = q.get("session") ?? "";
  if (mode !== "new" && mode !== "continue" && mode !== "resume")
    throw new Error(`Unknown mode: ${JSON.stringify(mode)}`);
  if (mode === "resume" && !SESSION_RE.test(session))
    throw new Error(`Bad session id: ${JSON.stringify(session)}`);
  let command = sessionCommand(harness, mode, session, codexLaunch);
  const rc = q.get("remote_control");
  if (rc !== null) {
    if (rc !== "1") throw new Error(`Bad remote_control: ${JSON.stringify(rc)}`);
    if (!matchedName) throw new Error("remote_control needs an existing workspace");
    // Codex has no Remote Control.
    if (harness === "claude") command += ` --remote-control ${shellQuote(matchedName)}`;
  }
  const prompt = q.get("prompt");
  if (prompt) command += ` ${shellQuote(prompt)}`;
  return { kind: "claude", workspace, command };
}

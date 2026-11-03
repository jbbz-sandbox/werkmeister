/**
 * Parse `vscode://jbbz.werkmeister-vscode/<claude|reconcile>?…` (SW-195), the
 * URI werkmeister-core's `launcher.ts` builds. No `vscode` import, so `node --test`
 * covers it. A URI is untrusted input (any app or page can open one): only a
 * workspace *name* and a reconcile *slug* are accepted, never a path or a command.
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

export function parseLaunchUri(uriPath: string, query: string): Launch {
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
  let command: string;
  if (mode === "new") command = "claude";
  else if (mode === "continue") command = "claude --continue";
  else if (mode === "resume") {
    if (!SESSION_RE.test(session)) throw new Error(`Bad session id: ${JSON.stringify(session)}`);
    command = `claude --resume ${session}`;
  } else throw new Error(`Unknown mode: ${JSON.stringify(mode)}`);
  const prompt = q.get("prompt");
  if (prompt) command += ` ${shellQuote(prompt)}`;
  return { kind: "claude", workspace, command };
}

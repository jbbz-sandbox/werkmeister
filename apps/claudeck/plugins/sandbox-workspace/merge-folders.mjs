// Pure: compute claudeck's folders.json (the flat project list the chat picker
// reads via /api/projects) from the existing array plus the sandbox workspace
// list. No IO. Managed entries carry `source: "sandbox"`; manual entries are
// preserved untouched unless they point at a vanished workspace directly under
// the workspaces root (those are leftovers from before the marker existed).
// Idempotent.
import { dirname, resolve } from "node:path";

const MANAGED_SOURCE = "sandbox";

/**
 * @param existing  current folders.json contents
 * @param workspaces  live workspaces (`listWorkspaces().workspaces`)
 * @param root  workspaces root (`listWorkspaces().root`)
 */
export function mergeFolders(existing, workspaces, root) {
  const list = Array.isArray(existing) ? existing : [];
  const live = new Set((workspaces || []).map((w) => w && w.path).filter(Boolean));
  const rootDir = root ? resolve(root) : null;
  // A manual entry sitting directly under the workspaces root is a workspace
  // that predates the marker — drop it once its directory is gone.
  const staleManual = (e) =>
    rootDir && e.path && dirname(resolve(e.path)) === rootDir && !live.has(e.path);

  const nonManaged = list.filter(
    (e) => e && e.source !== MANAGED_SOURCE && !staleManual(e),
  );

  // Paths already held by a manual (non-managed) entry — don't duplicate them.
  const manualPaths = new Set(nonManaged.map((e) => e && e.path).filter(Boolean));

  const managed = [];
  for (const ws of workspaces || []) {
    if (!ws || !ws.name || !ws.path) continue;
    if (manualPaths.has(ws.path)) continue;
    managed.push({ name: ws.name, path: ws.path, source: MANAGED_SOURCE });
  }

  return [...nonManaged, ...managed];
}

/**
 * The workspace name for one of claudeck's project paths, or null when the path
 * is not a workspace.
 *
 * Lives next to `mergeFolders` because it is the reverse lookup of what that
 * writes: the routes are keyed on a project path, while sandbox-core's
 * workspace calls are keyed on the name it resolves under the workspaces root.
 * Taking `basename(path)` instead would turn a project outside that root into a
 * confusing "No such workspace" rather than a clear "not a workspace".
 *
 * ponytail: compares resolved paths, not realpaths — a symlinked workspaces
 * root would miss. Add `realpath` on both sides if anyone hits it.
 */
export function workspaceNameForPath(workspaces, project) {
  if (!project) return null;
  const target = resolve(project);
  return (workspaces || []).find((w) => w && w.path && resolve(w.path) === target)?.name ?? null;
}

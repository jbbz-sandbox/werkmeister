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

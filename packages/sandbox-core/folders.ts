/**
 * claudeck's `folders.json` — the flat project list its chat picker reads via
 * `/api/projects` — computed from the existing list plus the sandbox workspaces.
 *
 * Pure, no IO. Lives here rather than beside either caller because there are
 * two writers of that one file and they must agree: claudeck's sandbox-workspace
 * plugin rewrites it at mount and on every `fs.watch` event, while this repo's
 * `scripts/sync-workspaces-to-claudeck.mjs` rewrites it on demand. When claudeck
 * moved to its own repo (2026-09-25) a copy in each would have been free to
 * drift, and two writers with different merge semantics fight over the file.
 * One implementation, imported by both.
 */
import { dirname, resolve } from "node:path";

const MANAGED_SOURCE = "sandbox";

/** One entry in claudeck's `folders.json`. */
export interface FolderEntry {
  name: string;
  path: string;
  /** `"sandbox"` on entries this merge owns; absent on ones a user added. */
  source?: string;
  [key: string]: unknown;
}

/** The subset of {@link WorkspaceEntry} the merge needs. */
interface WorkspaceLike {
  name: string;
  path: string;
}

/**
 * Managed entries carry `source: "sandbox"` and are rebuilt from `workspaces`.
 * Manual entries are preserved untouched, except one sitting *directly* under
 * the workspaces root whose directory is gone — that is a workspace registered
 * before the marker existed, so it is pruned too. Idempotent.
 *
 * @param existing current `folders.json` contents
 * @param workspaces live workspaces (`listWorkspaces().workspaces`)
 * @param root workspaces root (`listWorkspaces().root`)
 */
export function mergeFolders(
  existing: FolderEntry[] | unknown,
  workspaces: WorkspaceLike[] | null | undefined,
  root?: string | null,
): FolderEntry[] {
  const list: FolderEntry[] = Array.isArray(existing) ? existing : [];
  const live = new Set((workspaces || []).map((w) => w && w.path).filter(Boolean));
  const rootDir = root ? resolve(root) : null;
  // A manual entry sitting directly under the workspaces root is a workspace
  // that predates the marker — drop it once its directory is gone.
  const staleManual = (e: FolderEntry) =>
    rootDir && e.path && dirname(resolve(e.path)) === rootDir && !live.has(e.path);

  const nonManaged = list.filter((e) => e && e.source !== MANAGED_SOURCE && !staleManual(e));

  // Paths already held by a manual (non-managed) entry — don't duplicate them.
  const manualPaths = new Set(nonManaged.map((e) => e && e.path).filter(Boolean));

  const managed: FolderEntry[] = [];
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
 * The reverse lookup of what {@link mergeFolders} writes: callers are keyed on a
 * project path, while the workspace calls here are keyed on the name they
 * resolve under the workspaces root. Taking `basename(path)` instead would turn
 * a project outside that root into a confusing "No such workspace" rather than a
 * clear "not a workspace".
 *
 * ponytail: compares resolved paths, not realpaths — a symlinked workspaces
 * root would miss. Add `realpath` on both sides if anyone hits it.
 */
export function workspaceNameForPath(
  workspaces: WorkspaceLike[] | null | undefined,
  project: string | null | undefined,
): string | null {
  if (!project) return null;
  const target = resolve(project);
  return (workspaces || []).find((w) => w && w.path && resolve(w.path) === target)?.name ?? null;
}

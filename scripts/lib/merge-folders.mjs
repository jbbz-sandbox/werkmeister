// Pure: compute claudeck's folders.json (the flat project list the chat picker
// reads via /api/projects) from the existing array plus the sandbox workspace
// list. No IO. Managed entries carry `source: "sandbox"`; everything else is
// preserved untouched. Idempotent. Companion to merge-workspaces.mjs (which
// handles the Repos-tab repos.json).

const MANAGED_SOURCE = "sandbox";

export function mergeFolders(existing, workspaces) {
  const list = Array.isArray(existing) ? existing : [];
  const nonManaged = list.filter((e) => !(e && e.source === MANAGED_SOURCE));

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

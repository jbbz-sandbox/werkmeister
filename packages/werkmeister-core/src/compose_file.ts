/**
 * The one home for the name of a workspace's generated Compose file (#224).
 *
 * Compose v2 prefers `compose.yml`; workspaces generated before the rename hold
 * `docker-compose.yml` until `init-workspace` or `up` migrates them. Renaming is
 * safe for a running stack: Compose keys it by the file's `name:`, not its path.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const COMPOSE_FILE = "compose.yml";
/** Read as a fallback only, so teardown never misses a not-yet-migrated stack. */
export const LEGACY_COMPOSE_FILE = "docker-compose.yml";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** *workspace*'s compose file, preferring the current name; `null` if it has neither. */
export function findWorkspaceCompose(workspace: string): string | null {
  for (const name of [COMPOSE_FILE, LEGACY_COMPOSE_FILE]) {
    const p = path.join(workspace, name);
    if (isFile(p)) return p;
  }
  return null;
}

/** Rename a legacy `docker-compose.yml` to `compose.yml`, unless `compose.yml` already exists. */
export function migrateWorkspaceCompose(workspace: string): void {
  const legacy = path.join(workspace, LEGACY_COMPOSE_FILE);
  const current = path.join(workspace, COMPOSE_FILE);
  if (isFile(legacy) && !fs.existsSync(current)) {
    fs.renameSync(legacy, current);
  }
}

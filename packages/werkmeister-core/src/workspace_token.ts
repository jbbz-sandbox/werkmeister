/**
 * Per-workspace bearer tokens for the host daemon (SW-184). A token scopes its
 * caller to one workspace: the daemon lists only that workspace's verbs and
 * refuses any other workspace. Not a security boundary while ~/repos and
 * ~/features mount read-write into a container — it is the workspace's identity.
 *
 * Keyed by workspace directory name, not FEATURE: resolving a feature can fall
 * through to a synchronous `docker ps` (compose.ts workspaceForFeature), which
 * would stall every request the daemon is serving.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxHome } from "./config.js";
import { dotDir } from "./dot_dir.js";

export const WORKSPACE_TOKEN_FILE = "token";

export function tokensDir(): string {
  return path.join(sandboxHome(), "tokens");
}

/** The token a container in this workspace sends, git-ignored (worktrees.ts). */
export function workspaceTokenFile(workspaceRoot: string): string {
  return path.join(dotDir(workspaceRoot), WORKSPACE_TOKEN_FILE);
}

/** Reuse the workspace's token if it has one, else mint it; write both copies at 0600. */
export function mintWorkspaceToken(name: string, workspaceRoot: string): string {
  const hostFile = path.join(tokensDir(), name);
  let token = "";
  try {
    token = fs.readFileSync(hostFile, "utf8").trim();
  } catch {
    // absent — mint below
  }
  token ||= randomBytes(32).toString("hex");
  for (const file of [hostFile, workspaceTokenFile(workspaceRoot)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    // `mode` only applies at creation; an existing file keeps its old bits.
    fs.chmodSync(file, 0o600);
  }
  return token;
}

/**
 * Deletes a workspace's daemon token (`~/.werkmeister/tokens/<name>`), so the
 * werkmeister daemon stops accepting calls made with it. Containers in that
 * workspace can no longer reach the daemon until the workspace is
 * initialized again. Runs in-process and only deletes the file; it does not
 * call the daemon.
 *
 * @param name - The workspace folder's name (not its feature name).
 * @returns Nothing. A workspace with no token is not an error.
 * @throws A file system error when the token exists but can't be deleted.
 *
 * @example
 * ```ts
 * import { revokeWorkspaceToken } from "werkmeister-core/sdk";
 *
 * revokeWorkspaceToken("api-42-rate-limit");
 * console.log("token revoked");
 * ```
 */
export function revokeWorkspaceToken(name: string): void {
  fs.rmSync(path.join(tokensDir(), name), { force: true });
}

// The leftovers are mostly from tests of older versions and from workspaces
// removed by hand.
/**
 * Lists daemon tokens (in `~/.werkmeister/tokens`) whose workspace folder no
 * longer exists under a workspaces root, so you can revoke them. Runs
 * in-process and only reads folders; it does not call the daemon.
 *
 * @param workspacesRoot - The folder that holds your workspaces (the
 *   `paths.workspaces_root` setting in your werkmeister config).
 * @returns The stale token names, sorted; empty when there are none.
 * @throws `Error` when `workspacesRoot` can't be read, or holds no workspace
 *   folder while tokens exist: a wrong root would otherwise make every live
 *   token look stale.
 *
 * @example
 * ```ts
 * import { revokeWorkspaceToken, staleTokens } from "werkmeister-core/sdk";
 *
 * for (const name of staleTokens("/Users/me/features")) {
 *   revokeWorkspaceToken(name);
 *   console.log(`revoked ${name}`);
 * }
 * ```
 */
export function staleTokens(workspacesRoot: string): string[] {
  const live = new Set(
    fs
      .readdirSync(workspacesRoot, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(workspacesRoot, e.name))),
      )
      .map((e) => e.name),
  );
  let names: string[] = [];
  try {
    names = fs.readdirSync(tokensDir());
  } catch {
    // no tokens folder: nothing is stale
  }
  if (names.length && !live.size) {
    throw new Error(`no workspace folders found under ${workspacesRoot}`);
  }
  return names.filter((n) => !live.has(n)).sort();
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

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
import * as os from "node:os";
import * as path from "node:path";

import { dotDir } from "./dot_dir.js";

export const WORKSPACE_TOKEN_FILE = "token";

export function tokensDir(): string {
  return path.join(dotDir(os.homedir()), "tokens");
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

export function revokeWorkspaceToken(name: string): void {
  fs.rmSync(path.join(tokensDir(), name), { force: true });
}

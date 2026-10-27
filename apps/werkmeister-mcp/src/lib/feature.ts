/**
 * Which workspace is this call about?
 *
 * Every workspace-scoped tool takes one optional `workspace` argument: a
 * workspace directory name (as `list-workspaces` reports it) or a feature name.
 * A container agent omits it — the server cannot see the client's cwd, so the
 * feature travels in `X-Werkmeister-Feature`, pinned by the workspace's own
 * generated `.mcp.json`.
 *
 * The directory name is tried first because it is what the UI and the pane hold
 * and it resolves before the workspace was ever brought up; a feature name goes
 * through the same `workspaceForFeature` every other consumer uses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceForFeature } from "werkmeister-core/compose";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import { workspacesRoot } from "werkmeister-core/config";
import { SandboxError } from "werkmeister-core/errors";

/** Lower-cased: Node lower-cases incoming header names. */
export const FEATURE_HEADER = "x-werkmeister-feature";
/** Sent by a `.mcp.json` generated before SW-106; drop once every workspace has re-run init-workspace. */
const PRE_RENAME_FEATURE_HEADER = "x-sandbox-feature";

export type ReqHeaders = Record<string, string | string[] | undefined> | undefined;

export interface Workspace {
  /** Directory name under the workspaces root — the key the name-based core calls take. */
  name: string;
  dir: string;
  /** `FEATURE` from the workspace's `.env`; null before init-workspace wrote it. */
  feature: string | null;
}

/** The `workspace` argument, else the header, trimmed; a coded error when neither is set. */
export function workspaceId(explicit: string | undefined, headers: ReqHeaders): string {
  const raw = headers?.[FEATURE_HEADER] ?? headers?.[PRE_RENAME_FEATURE_HEADER];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  const id = (explicit?.trim() || fromHeader?.trim()) ?? "";
  if (!id) {
    throw new SandboxError(
      "No workspace for this call. Pass a `workspace` argument, or set the " +
        "X-Werkmeister-Feature header on the MCP connection (the workspace's " +
        ".mcp.json does this for you).",
      "NO_WORKSPACE",
    );
  }
  return id;
}

function envFeature(dir: string): string | null {
  try {
    const m = /^\s*FEATURE=(.*)$/m.exec(fs.readFileSync(path.join(dir, ".env"), "utf8"));
    return m?.[1].trim() || null;
  } catch {
    return null;
  }
}

export function resolveWorkspace(explicit: string | undefined, headers: ReqHeaders): Workspace {
  const id = workspaceId(explicit, headers);
  if (!/[/\\]|\.\./.test(id)) {
    const dir = path.join(workspacesRoot(), id);
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      return { name: id, dir, feature: envFeature(dir) };
    }
  }
  const dir = workspaceForFeature(id);
  if (dir === null) {
    throw new SandboxError(
      `Could not resolve workspace '${id}' — no directory of that name under the ` +
        "workspaces root, no running containers carry it as a feature label, and no " +
        `workspace directory holds its ${COMPOSE_FILE}.`,
      "WORKSPACE",
    );
  }
  return { name: path.basename(dir), dir, feature: id };
}

/** The resolved workspace's feature, or a coded error when it has none yet. */
export function resolveFeature(
  explicit: string | undefined,
  headers: ReqHeaders,
): Workspace & { feature: string } {
  const ws = resolveWorkspace(explicit, headers);
  if (ws.feature === null) {
    throw new SandboxError(
      `Workspace '${ws.name}' has no FEATURE in its .env — run init-workspace there first.`,
      "WORKSPACE",
    );
  }
  return { ...ws, feature: ws.feature };
}

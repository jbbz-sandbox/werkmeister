/**
 * Which feature is this call about, and where does its workspace live?
 *
 * One container mounts all of `~/features` and the agent is opened in a feature
 * directory — but the server cannot see the client's cwd, so the feature
 * travels in `X-Sandbox-Feature`, pinned by the workspace's own generated
 * `.mcp.json`. Every tool that takes a feature declares it as an *optional*
 * argument defaulting to the header, so an agent working across two features
 * can still name one.
 *
 * The workspace directory is never a second header: it is resolved from the
 * feature by the same `workspaceForFeature` every other consumer uses.
 */

import { workspaceForFeature } from "werkmeister-core/compose";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import { SandboxError } from "werkmeister-core/errors";

/** Lower-cased: Node lower-cases incoming header names. */
export const FEATURE_HEADER = "x-sandbox-feature";

export type ReqHeaders = Record<string, string | string[] | undefined> | undefined;

export function resolveFeature(explicit: string | undefined, headers: ReqHeaders): string {
  const raw = headers?.[FEATURE_HEADER];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  const feature = (explicit ?? fromHeader ?? "").trim();
  if (!feature) {
    throw new SandboxError(
      "No feature for this call. Pass a `feature` argument, or set the " +
        "X-Sandbox-Feature header on the MCP connection (the workspace's " +
        ".mcp.json does this for you).",
      "NO_FEATURE",
    );
  }
  return feature;
}

/** The feature's workspace directory, or a coded error the caller can render. */
export function resolveWorkspaceDir(feature: string): string {
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    throw new SandboxError(
      `Could not resolve a workspace for feature '${feature}' — no running ` +
        "containers carry its label and no workspace directory holds its " +
        `${COMPOSE_FILE}.`,
      "WORKSPACE",
    );
  }
  return workspace;
}

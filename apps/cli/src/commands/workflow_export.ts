/**
 * werkmeister workflow export <workspace> --to <dir>
 *
 * Write an ICM workspace's stages out as a workflow folder (SW-1079); the work is
 * `werkmeister-core`'s `exportWorkflow`, which refuses a non-icm workspace or a non-empty <dir>.
 */

import * as path from "node:path";
import { resolveWorkspaceDir } from "werkmeister-core";
import { exportWorkflow } from "werkmeister-core/strategies";
import { success, warn } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const ws = String(args.workspace);
  // A path ("." or anything with a slash) or a workspace name, as `workspace list` prints it.
  const root = ws === "." || ws.includes("/") ? path.resolve(ws) : await resolveWorkspaceDir(ws);
  const to = path.resolve(String(args.to));
  const { stages, warnings } = exportWorkflow(root, to);
  for (const w of warnings) warn(w);
  success(`Exported ${stages.length} stages (${stages.join(", ")}) to ${to}`);
}

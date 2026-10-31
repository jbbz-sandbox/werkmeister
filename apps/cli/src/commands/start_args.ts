/**
 * werkmeister workspace prompt --args [--start <dir>]
 *
 * Print start_session's title, model, prompt and background for the enclosing
 * workspace as JSON (SW-153): what the next-wave skill passes to start_session,
 * built by the same werkmeister-core function as the pane's ▶ Start work.
 */

import { startArgs } from "werkmeister-core";
import { findWorkspaceDir } from "./starting_prompt.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  console.log(JSON.stringify(await startArgs(findWorkspaceDir(args.start as string | null))));
}

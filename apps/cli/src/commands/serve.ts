/**
 * werkmeister workspace serve <dir>
 *
 * Serve a folder inside this workspace on loopback for a browser check (SW-963).
 * The checks are `werkmeister-core`'s `staticServer`.
 */

import { spawn } from "node:child_process";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { staticServer } from "werkmeister-core/serve_static";
import { error } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const cwd = process.cwd();
  const server = staticServer(findRecordRoot(cwd), String(args.dir), cwd);
  if ("error" in server) {
    error(server.error);
    process.exit(1);
  }
  const [cmd, ...argv] = server.argv;
  process.exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd as string, argv, { stdio: "inherit" });
    // A task stop signals this process; pass it on so python3 never outlives it.
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    child.on("error", (e) => {
      error(`python3: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

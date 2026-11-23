/**
 * `werkmeister workspace serve <dir>` (SW-963): the static-page server for an ICM browser check.
 * AUTONOMOUS_DENY denies `python3:*` (SW-521), so the contract names this command, and its stage grant
 * allows it; the checks here are what make that grant safe.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The only server line it runs: loopback, an ephemeral port, `-I` so no PYTHON* env or cwd module loads. */
export const staticServerArgv = (dir: string) => [
  "python3",
  "-I",
  "-u",
  "-m",
  "http.server",
  "0",
  "-b",
  "127.0.0.1",
  "-d",
  dir,
];

/**
 * The argv that serves *dir*, or an error when its realpath is not a folder inside the workspace's,
 * is the workspace folder itself, or is in a dot-folder: the root's `.werkmeister/token` (the daemon's
 * bearer token) and `.env*` files would be served to anything reaching host loopback, containers too.
 * Only *dir* itself is resolved: http.server still follows a symlink inside it.
 *
 * @param workspaceRoot - The workspace folder (`findRecordRoot`), or null outside one.
 * @param dir - The folder to serve, relative to *cwd* or absolute.
 * @param cwd - What *dir* is relative to.
 */
export function staticServer(
  workspaceRoot: string | null,
  dir: string,
  cwd: string,
): { argv: string[] } | { error: string } {
  if (!workspaceRoot)
    return { error: "Not inside a workspace (no .werkmeister/workspace.yml above it)." };
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(cwd, dir));
  } catch {
    return { error: `${dir} does not exist.` };
  }
  if (!fs.statSync(real).isDirectory()) return { error: `${dir} is not a directory.` };
  const root = fs.realpathSync(workspaceRoot);
  if (real !== root && !real.startsWith(`${root}${path.sep}`))
    return { error: `${dir} resolves to ${real}, outside the workspace ${root}.` };
  const rel = path.relative(root, real);
  if (!rel || rel.split(path.sep).some((s) => s.startsWith(".")))
    return {
      error: `${dir} is the workspace folder itself or a dot-folder in it, which hold its token and .env files: serve a folder such as stages.`,
    };
  return { argv: staticServerArgv(real) };
}

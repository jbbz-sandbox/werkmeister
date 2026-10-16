/**
 * Warn when `dist/` was bundled from a different commit than the checkout.
 *
 * A linked dev CLI runs `dist/main.js`, a gitignored esbuild bundle (sandbox-core
 * included), so a pull or a branch switch changes the source but not what runs.
 * On 2026-10-15 that cost an hour: the gate kept rejecting a valid `skip_tests`
 * because dist predated the merged #145 fix. esbuild.mjs stamps the source SHA
 * into the bundle; this compares it with the checkout's HEAD.
 *
 * Only a monorepo checkout is checked (`<SANDBOX_ROOT>/../../.git`): a published
 * install has no .git, and the existsSync keeps it from spawning git at all.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type BuildStamp = { sha: string; dirty: boolean };

declare const __SANDBOX_BUILD__: BuildStamp | undefined;

/** The stamp esbuild.mjs defined, or undefined when running from source (tsx, vitest). */
export const BUILD_STAMP: BuildStamp | undefined =
  typeof __SANDBOX_BUILD__ === "undefined" ? undefined : __SANDBOX_BUILD__;

export const REBUILD_COMMAND = "npm run build --workspace sandbox-core && npm run build --workspace apps/cli";

/**
 * The warning text when *build* came from a commit other than *repoRoot*'s
 * HEAD, else null. A dirty build at the same SHA is not flagged: there is no
 * telling whether its uncommitted changes are the ones still on disk.
 */
export function staleBuildWarning(build: BuildStamp | undefined, repoRoot: string): string | null {
  if (!build?.sha || !fs.existsSync(path.join(repoRoot, ".git"))) return null;
  let head: string;
  try {
    head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (head === build.sha) return null;
  const built = build.sha.slice(0, 7) + (build.dirty ? " (+uncommitted changes)" : "");
  return (
    `warning: this sandbox CLI was built from ${built}, but ${repoRoot} is at ${head.slice(0, 7)}.\n` +
    `  Rebuild it from ${repoRoot}: ${REBUILD_COMMAND}`
  );
}

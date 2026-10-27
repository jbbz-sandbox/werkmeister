/**
 * Warn when `dist/` was bundled from a different commit than the checkout.
 *
 * A linked dev CLI runs `dist/main.js`, a gitignored esbuild bundle (werkmeister-core
 * included), so a pull or a branch switch changes the source but not what runs.
 * On 2026-10-15 that cost an hour: the gate kept rejecting a valid `skip_tests`
 * because dist predated the merged #145 fix. esbuild.mjs stamps the source SHA
 * into the bundle; this compares it with the checkout's HEAD.
 *
 * Only a monorepo checkout is checked (`<WERKMEISTER_ROOT>/../../.git`): a published
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

export const REBUILD_COMMAND = "pnpm turbo run build --filter=werkmeister";

/** esbuild.mjs's entry points, the workspace package they import, and the lockfile pinning the rest. */
const BUNDLE_SOURCES = [
  "apps/cli",
  "apps/werkmeister-mcp",
  "packages/werkmeister-core",
  "pnpm-lock.yaml",
];

/**
 * The warning text when *build* came from a commit other than *repoRoot*'s
 * HEAD and a bundled source changed between the two, else null. A dirty build
 * at the same SHA is not flagged: there is no telling whether its uncommitted
 * changes are the ones still on disk.
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
  // turbo keys the build cache on these sources, not HEAD, so a docs-only commit
  // replays a dist still stamped with the older SHA (SW-128).
  try {
    execFileSync(
      "git",
      ["-C", repoRoot, "diff", "--quiet", build.sha, head, "--", ...BUNDLE_SOURCES],
      {
        stdio: "ignore",
      },
    );
    return null;
  } catch {
    // Changed sources (exit 1) or a SHA this clone lacks: the bundle may be stale.
  }
  const built = build.sha.slice(0, 7) + (build.dirty ? " (+uncommitted changes)" : "");
  return (
    `warning: this werkmeister CLI was built from ${built}, but ${repoRoot} is at ${head.slice(0, 7)}.\n` +
    `  Rebuild it from ${repoRoot}: ${REBUILD_COMMAND}`
  );
}

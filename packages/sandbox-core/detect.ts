/**
 * Service auto-detection for the developer sandbox.
 *
 * Scans a feature's workspace (a set of git worktrees) and determines
 * which services have been modified relative to main. Changed file paths
 * are mapped to services via the services.yaml path mappings.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors } from "./colors.js";
import { loadServices, resolveWorkspace } from "./config.js";
import { info, warn } from "./reporter.js";
import { ProcError, run } from "./proc.js";

/** Run `git diff main..HEAD --name-only` in *repoPath* and return changed files. */
function _runGitDiff(repoPath: string): string[] {
  try {
    let result = run(["git", "diff", "main..HEAD", "--name-only"], {
      cwd: repoPath,
      capture: true,
      timeout: 30,
    });
    if (result.status !== 0) {
      // Might be on main itself -- try diffing against origin/main
      result = run(["git", "diff", "origin/main..HEAD", "--name-only"], {
        cwd: repoPath,
        capture: true,
        timeout: 30,
      });
    }
    if (result.status !== 0) {
      warn(`git diff failed in ${repoPath}: ${result.stderr.trim()}`);
      return [];
    }
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line);
  } catch (exc) {
    if (exc instanceof ProcError && exc.code === "ENOENT") {
      warn(`git not found -- cannot diff ${repoPath}`);
      return [];
    }
    if (exc instanceof ProcError && exc.code === "ETIMEDOUT") {
      warn(`git diff timed out in ${repoPath}`);
      return [];
    }
    throw exc;
  }
}

/**
 * Derive the canonical repo name from a worktree directory.
 *
 * The workspace layout is:
 *     $SANDBOX_WORKSPACES_ROOT/<feature>/<repo>/   (default: ~/workspace)
 * so the repo name is simply the directory name.
 */
function _getRepoName(repoPath: string): string {
  return path.basename(repoPath);
}

/**
 * Map a list of changed file paths in *repoName* to service names.
 *
 * A service matches if:
 *   - Its `repo` field matches *repoName*, AND
 *   - Any changed file starts with its `path` field (or path is `"."`
 *     meaning the whole repo is the service).
 */
function _mapFilesToServices(
  repoName: string,
  changedFiles: string[],
  servicesConfig: Record<string, any>,
): string[] {
  const matched: string[] = [];
  for (const [svcName, svcCfg] of Object.entries(servicesConfig)) {
    if (typeof svcCfg !== "object" || svcCfg === null || Array.isArray(svcCfg)) {
      continue;
    }
    const svcRepo = svcCfg["repo"] ?? "";
    const svcPath = svcCfg["path"] ?? ".";

    if (svcRepo !== repoName) {
      continue;
    }

    // If the service covers the entire repo, any change matches
    if (svcPath === "." || svcPath === "" || svcPath === "/") {
      if (changedFiles.length) {
        matched.push(svcName);
      }
      continue;
    }

    // Normalise: strip leading/trailing slashes for prefix matching
    const prefix = String(svcPath).replace(/^\/+|\/+$/g, "");
    for (const cf of changedFiles) {
      if (cf.startsWith(prefix + "/") || cf === prefix) {
        matched.push(svcName);
        break; // one match is enough for this service
      }
    }
  }

  return matched;
}

/**
 * Detect which services have code changes for *featureName*.
 *
 * Steps:
 *   1. Resolve the workspace directory (Vibe Kanban or standalone)
 *   2. List all repo directories in the workspace
 *   3. For each repo: run `git diff main..HEAD --name-only`
 *   4. Map changed file paths to services using services.yaml mappings
 *   5. Return the deduplicated list of detected service names
 *
 * `servicesConfig` is a pre-loaded services dict (loaded from disk when
 * omitted). `workspaceOverride` is an explicit path to a directory containing
 * repo checkouts; when provided, repos are expected at `<workspace>/<repo>/`
 * (flat layout, no feature subdirectory).
 *
 * Returns a sorted list of service names that have changes.
 */
export function detectChangedServices(
  featureName: string,
  servicesConfig?: Record<string, any> | null,
  workspaceOverride?: string | null,
): string[] {
  if (servicesConfig === undefined || servicesConfig === null) {
    servicesConfig = loadServices();
  }

  const workspace = resolveWorkspace(featureName, workspaceOverride);
  if (!(fs.existsSync(workspace) && fs.statSync(workspace).isDirectory())) {
    warn(`Workspace not found: ${workspace}`);
    return [];
  }

  info(`Scanning workspace: ${workspace}`);
  const detected = new Set<string>();

  // Build set of repo names referenced in services.yaml so we only
  // scan relevant directories (important in standalone mode where the
  // workspace may contain unrelated directories).
  const knownRepos = new Set<string>();
  for (const svcCfg of Object.values(servicesConfig)) {
    if (typeof svcCfg === "object" && svcCfg !== null && !Array.isArray(svcCfg) && svcCfg["repo"]) {
      knownRepos.add(svcCfg["repo"]);
    }
  }

  // Iterate over subdirectories (each is a repo worktree/checkout)
  for (const name of fs.readdirSync(workspace).sort()) {
    const entry = path.join(workspace, name);
    if (!fs.statSync(entry).isDirectory()) {
      continue;
    }
    // Skip hidden directories
    if (name.startsWith(".")) {
      continue;
    }

    const repoName = _getRepoName(entry);

    // In standalone mode, skip directories that aren't known repos
    if (knownRepos.size && !knownRepos.has(repoName)) {
      continue;
    }

    const changed = _runGitDiff(entry);

    if (!changed.length) {
      continue;
    }

    console.log(
      `  ${Colors.DIM}${repoName}: ` +
      `${changed.length} changed file(s)${Colors.RESET}`,
    );

    const matched = _mapFilesToServices(repoName, changed, servicesConfig);
    for (const svc of matched) {
      console.log(`    -> ${Colors.GREEN}${svc}${Colors.RESET}`);
      detected.add(svc);
    }
  }

  return [...detected].sort();
}

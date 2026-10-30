/**
 * Shared git-worktree helpers for workspaces.
 *
 * `werkmeister workspace` creates the workspace ROOT (a worktree of the
 * sandbox-workspace repo); `werkmeister init-workspace` reconciles the nested
 * per-repo worktrees against the desired set declared in
 * `.werkmeister/workspace.yml`. Both commands share the primitives here so
 * worktree creation/removal behaves identically wherever it runs — and so the
 * two command modules don't import each other (avoids a circular import).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./proc.js";
import { info } from "./reporter.js";

// ---------------------------------------------------------------------------
// Workspace .gitignore (managed section)
// ---------------------------------------------------------------------------

const _GITIGNORE_MARKER = "# --- sandbox workspace (managed section)"; // name-check: ignore

const _GITIGNORE_HEADER =
  `${_GITIGNORE_MARKER} -----------------------------------\n` +
  "# Repo worktrees nested in this workspace, ignored by name. Rewritten by\n" +
  "# `werkmeister init-workspace` on each run; rules above come from the repo's main.\n";

// Ignored besides the repo worktree dirs: secrets (.env.<svc> holds each
// service's resolved secrets) and files `up`, the PR gate and the agent-state hook
// rewrite at runtime — compose.yml carries the slot's ports, and the slot lives on
// container labels — which would otherwise leave the record branch dirty (SW-144).
// The other generated projections (.claude/, CLAUDE.md, .mcp.json, .werkmeister/*)
// are deliberately TRACKED — versioned workspace state is the point of the root repo.
const _RUNTIME_FILES = [
  "compose.yml",
  "compose.gate.yml",
  ".werkmeister/agent-state.json",
  ".werkmeister/last-exec",
  ".werkmeister/starts.json",
  ".werkmeister/token",
];
const _GITIGNORE_GENERATED = [
  "/.env",
  "/.env.*",
  ..._RUNTIME_FILES.map((file) => `/${file}`),
] as const;

/** An ignore rule does not untrack a file an older init committed (compose.yml was). */
function untrackRuntimeFiles(workspaceDir: string): void {
  const untrack = ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ..._RUNTIME_FILES];
  run(["git", "-C", workspaceDir, ...untrack], { capture: true });
}

/**
 * Append the generated-file rules a workspace .gitignore written before them lacks.
 * `werkmeister up` writes these files without rerunning init-workspace, and
 * close-out (removeWorkspace) commits tracked changes and pushes.
 */
export function ensureGeneratedIgnored(workspaceDir: string): void {
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    /* absent */
  }
  const have = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = _GITIGNORE_GENERATED.filter((rule) => !have.has(rule));
  if (!missing.length) return;
  const joiner = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${joiner}${missing.join("\n")}\n`);
  untrackRuntimeFiles(workspaceDir);
}

/**
 * Rewrite the managed section of the workspace root's .gitignore.
 *
 * Ignores the nested repo worktree dirs (which vary per workspace and change
 * as repos are added/removed) plus .env and runtime files. Everything else — the projected
 * .claude/, generated context files, workspace.yml, notes — stays tracked.
 * The repo's own .gitignore rules (the branch is cut from its main) sit above
 * the marker and are preserved; only the managed section below it is replaced,
 * so a changed repo set is reflected on every reconcile.
 */
export function writeWorkspaceGitignore(workspaceDir: string, repos: string[]): void {
  const lines = [...repos.map((repo) => `/${repo}/`), ..._GITIGNORE_GENERATED];
  const section = _GITIGNORE_HEADER + lines.join("\n") + "\n";
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  let existing =
    fs.existsSync(gitignorePath) && fs.statSync(gitignorePath).isFile()
      ? fs.readFileSync(gitignorePath, "utf8")
      : "";
  if (existing.includes(_GITIGNORE_MARKER)) {
    existing = existing.slice(0, existing.indexOf(_GITIGNORE_MARKER)).replace(/\n+$/, "");
    existing = existing ? `${existing}\n` : "";
  }
  const joiner = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, existing + joiner + (existing ? "\n" : "") + section);
  untrackRuntimeFiles(workspaceDir);
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which repos to create worktrees for.
 *
 * Returns `[repos, services, unknownServices]`:
 *
 * - `repos`: sorted, de-duplicated repo names — the union of the explicit
 *   `repos` list and the repos that own each requested `service`.
 * - `services`: the cleaned `services` list.
 * - `unknownServices`: requested services not found in `services.yaml`.
 */
export function resolveRepos(
  reposArg: string | null | undefined,
  servicesArg: string | null | undefined,
  servicesConfig: Record<string, any>,
): [string[], string[], string[]] {
  const repos = new Set<string>();

  const explicit = (reposArg ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r);
  for (const repo of explicit) {
    repos.add(repo);
  }

  const services = (servicesArg ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  const unknown: string[] = [];
  for (const svc of services) {
    const svcDef = servicesConfig[svc];
    const repo =
      typeof svcDef === "object" && svcDef !== null && !Array.isArray(svcDef)
        ? svcDef["repo"]
        : null;
    if (repo) {
      repos.add(repo);
    } else {
      unknown.push(svc);
    }
  }

  return [[...repos].sort(), services, unknown];
}

// ---------------------------------------------------------------------------
// Git worktree primitives
// ---------------------------------------------------------------------------

/**
 * Resolve the source repo's default branch as a remote ref (e.g. `origin/main`).
 *
 * Fetches `origin` first so the new branch is cut from up-to-date history.
 * Falls back to `origin/main` / `origin/master` if `origin/HEAD` is unset.
 */
export function defaultBaseRef(src: string): string {
  run(["git", "-C", src, "fetch", "origin", "--prune", "--quiet"], { capture: true });

  const originHead = (): string | null => {
    const result = run(["git", "-C", src, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
      capture: true,
    });
    const ref = result.stdout.trim();
    const prefix = "refs/remotes/";
    if (result.status === 0 && ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
    return null;
  };

  let head = originHead();
  if (head) {
    return head;
  }

  // origin/HEAD not recorded locally — ask the remote, then retry.
  run(["git", "-C", src, "remote", "set-head", "origin", "--auto"], { capture: true });
  head = originHead();
  if (head) {
    return head;
  }

  for (const cand of ["origin/main", "origin/master"]) {
    const ok = run(["git", "-C", src, "rev-parse", "--verify", "--quiet", cand], {
      capture: true,
    });
    if (ok.status === 0) {
      return cand;
    }
  }

  throw new Error(`Could not determine default branch for ${src}`);
}

/**
 * Create a worktree at *dest* on *branch* cut from *src*'s default branch.
 *
 * Reuses *branch* if it already exists in *src* (a prior worktree in this
 * workspace created it) so a repo added to an existing workspace lands on the
 * same `<user>/<workspace>` branch as its siblings.
 *
 * A *branch* that exists only on origin was left by an earlier workspace of the
 * same name (close-out keeps the pushed branch). Cutting a fresh one
 * from main would diverge from it and the eventual handoff push would be
 * rejected, so this aborts with the two ways out — unless `force`, which
 * deletes the remote branch first.
 */
export function createWorktree(
  src: string,
  dest: string,
  branch: string,
  { force = false }: { force?: boolean } = {},
): void {
  const repo = path.basename(src);
  const exists = run(
    ["git", "-C", src, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { capture: true },
  );
  let cmd: string[];
  if (exists.status === 0) {
    info(`  ${repo}: worktree → ${branch} (existing branch)`);
    cmd = ["git", "-C", src, "worktree", "add", dest, branch];
  } else {
    const base = defaultBaseRef(src);
    const remote = `origin/${branch}`;
    const onOrigin = run(["git", "-C", src, "rev-parse", "--verify", "--quiet", remote], {
      capture: true,
    });
    if (onOrigin.status === 0 && force) {
      const del = run(["git", "-C", src, "push", "origin", "--delete", branch], { capture: true });
      if (del.status !== 0) {
        throw new Error(`${repo}: could not delete ${remote}: ${del.stderr.trim()}`);
      }
      info(`  ${repo}: deleted ${remote} (--force)`);
    } else if (onOrigin.status === 0) {
      const tip = run(["git", "-C", src, "log", "-1", "--format=%cs %s", remote], {
        capture: true,
      }).stdout.trim();
      throw new Error(
        `${repo}: branch '${branch}' already exists on origin (last commit: ${tip}), ` +
          "left by an earlier workspace of the same name.\n" +
          `  Continue that work (nothing lost):  git -C ${src} branch ${branch} ${remote}\n` +
          "                                      then rerun; the worktree lands on that branch.\n" +
          "  Start over (deletes the remote branch): rerun with --force\n" +
          "  Keep both: pick a different feature name.",
      );
    }
    info(`  ${repo}: worktree → ${branch} (from ${base})`);
    // --no-track: branching from origin/main would set it as upstream, and a plain `git push` then fails (SW-146).
    cmd = ["git", "-C", src, "worktree", "add", "--no-track", "-b", branch, dest, base];
  }
  const result = run(cmd, { capture: true });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git worktree add failed for ${repo}`);
  }
  if (exists.status !== 0) {
    // Point upstream at the not-yet-pushed same-named branch so the first plain `git push` creates it.
    for (const [key, value] of [
      ["remote", "origin"],
      ["merge", `refs/heads/${branch}`],
    ]) {
      run(["git", "-C", src, "config", `branch.${branch}.${key}`, value], { capture: true });
    }
  }
}

/**
 * True if the worktree at *dest* has uncommitted changes or untracked files.
 *
 * ponytail: "edits" == working-tree/index dirtiness (git status --porcelain).
 * Unpushed *commits* are not counted — a repo whose only divergence is
 * committed work is treated as safe to remove (the branch survives the
 * worktree removal, so the commits aren't lost). Widen to check ahead/behind
 * if losing committed-but-unpushed work becomes a real risk.
 */
export function worktreeIsDirty(dest: string): boolean {
  const result = run(["git", "-C", dest, "status", "--porcelain"], { capture: true });
  return Boolean(result.stdout.trim());
}

/**
 * Force-remove the worktree at *dest* and delete its *branch* in *src*.
 *
 * Returns `[ok, message]`. `git worktree remove` never deletes the branch
 * the worktree add created, so we delete it too — otherwise re-adding the same
 * repo later fails with "branch already exists". Branch deletion failure is
 * non-fatal (reported in the message) since the worktree itself is gone.
 */
export function removeWorktree(src: string, dest: string, branch: string): [boolean, string] {
  const result = run(["git", "-C", src, "worktree", "remove", "--force", dest], {
    capture: true,
  });
  if (result.status !== 0) {
    return [false, result.stderr.trim() || `could not remove worktree ${dest}`];
  }
  const branchResult = run(["git", "-C", src, "branch", "-D", branch], { capture: true });
  if (branchResult.status !== 0) {
    return [true, `worktree removed but branch ${branch} lingered: ${branchResult.stderr.trim()}`];
  }
  return [true, ""];
}

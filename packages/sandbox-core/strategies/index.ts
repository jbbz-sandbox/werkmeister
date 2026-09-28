/**
 * The strategy registry. The only importer of `jit.ts` / `icm.ts`: every
 * dispatch site asks `strategyFor(workspaceRoot)` and never names a strategy.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SandboxError } from "../errors.js";
import { run as procRun } from "../proc.js";
import { success, warn } from "../reporter.js";
import { _WORKSPACE_CONFIG_NAMES, expandUserPath, loadWorkspaceConfig } from "../workspace_prompts.js";
import { icm } from "./icm.js";
import { jit } from "./jit.js";
import { STRATEGY_IDS } from "./types.js";
import type { ContextStrategy, StrategyId } from "./types.js";

export { STRATEGY_IDS } from "./types.js";
export type { ContextStrategy, InitContext, StrategyId } from "./types.js";

const REGISTRY: Record<StrategyId, ContextStrategy> = { jit, icm };

export function strategyById(id: StrategyId): ContextStrategy {
  return REGISTRY[id];
}

/** Absent or blank → jit. Anything else must name a registered strategy. */
export function parseStrategyId(value: unknown): StrategyId {
  const id = value === undefined || value === null ? "" : String(value).trim();
  if (!id) return "jit";
  if ((STRATEGY_IDS as readonly string[]).includes(id)) return id as StrategyId;
  throw new SandboxError(
    `Unknown context_strategy '${id}' in workspace.yml — expected one of: ${STRATEGY_IDS.join(", ")}`,
    "UNKNOWN_CONTEXT_STRATEGY",
  );
}

/**
 * The workspace's `context_strategy`. Reads the config files itself rather than
 * through `loadConfigFile`, which logs: `notes context` stdout is injected into
 * the session. Same search order; an unreadable file reads as jit, as
 * loadConfigFile treats it as empty.
 */
export function readContextStrategy(workspaceRoot: string): StrategyId {
  const candidates: string[] = [];
  const envOverride = process.env["SANDBOX_WORKSPACE_CONFIG"];
  if (envOverride) candidates.push(expandUserPath(envOverride));
  for (const name of _WORKSPACE_CONFIG_NAMES) candidates.push(path.join(workspaceRoot, ".sandbox", name));
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let data: any;
    try {
      data = loadWorkspaceConfig(p);
    } catch {
      return "jit";
    }
    const isMapping = typeof data === "object" && data !== null && !Array.isArray(data);
    return parseStrategyId(isMapping ? data["context_strategy"] : undefined);
  }
  return "jit";
}

/** The strategy that owns *workspaceRoot*'s context layer. */
export function strategyFor(workspaceRoot: string): ContextStrategy {
  return REGISTRY[readContextStrategy(workspaceRoot)];
}

/** Expand `ownedPaths` against the workspace; a trailing `*` is a name-prefix glob. */
function expandOwned(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("*")) {
      if (fs.existsSync(path.join(root, pattern))) out.push(pattern);
      continue;
    }
    const dir = path.dirname(pattern);
    const prefix = path.basename(pattern).slice(0, -1);
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) if (name.startsWith(prefix)) out.push(path.join(dir, name));
  }
  return out;
}

/** What *from* left behind that *to* does not also own. */
export function leftoverPaths(root: string, from: ContextStrategy, to: ContextStrategy): string[] {
  const keep = new Set(expandOwned(root, to.ownedPaths()));
  return expandOwned(root, from.ownedPaths()).filter((p) => !keep.has(p));
}

// Tracked and clean is the only state git can put back, so it is the only
// state --prune-context deletes. Untracked, ignored, modified and non-git
// paths are kept.
function restorable(root: string, rel: string): boolean {
  const tracked = procRun(["git", "-C", root, "ls-files", "--error-unmatch", "--", rel], { capture: true });
  if (tracked.status !== 0) return false;
  const status = procRun(
    ["git", "-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", rel],
    { capture: true },
  );
  return status.status === 0 && !status.stdout.trim();
}

/** docs/superpowers/specs/2026-09-27-context-strategy-interface.md §3.6: warn about the old layer, or prune it. */
export function reportLeftovers(root: string, from: ContextStrategy, to: ContextStrategy, prune: boolean): void {
  const left = leftoverPaths(root, from, to);
  if (!left.length) return;
  if (!prune) {
    warn(
      `${from.id} layer still present: ${left.join(", ")}; remove by hand or run ` +
        "`sandbox init-workspace --prune-context`",
    );
    return;
  }
  for (const rel of left) {
    if (restorable(root, rel)) {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      success(`Pruned ${rel}`);
    } else {
      warn(`Kept ${rel}: untracked, ignored or modified — git could not restore it`);
    }
  }
}

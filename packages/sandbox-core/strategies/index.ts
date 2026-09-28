/**
 * The strategy registry. The only importer of `jit.ts` / `icm.ts`: every
 * dispatch site asks `strategyFor(workspaceRoot)` and never names a strategy.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SandboxError } from "../errors.js";
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

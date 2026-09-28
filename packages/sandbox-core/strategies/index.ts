/**
 * The strategy registry. The only importer of `jit.ts` / `icm.ts`: every
 * dispatch site asks `strategyFor(workspaceRoot)` and never names a strategy.
 */

import { icm } from "./icm.js";
import { jit } from "./jit.js";
import type { ContextStrategy, StrategyId } from "./types.js";

export { STRATEGY_IDS } from "./types.js";
export type { ContextStrategy, InitContext, StrategyId } from "./types.js";

const REGISTRY: Record<StrategyId, ContextStrategy> = { jit, icm };

export function strategyById(id: StrategyId): ContextStrategy {
  return REGISTRY[id];
}

/** The strategy that owns *workspaceRoot*'s context layer. */
export function strategyFor(_workspaceRoot: string): ContextStrategy {
  return REGISTRY.jit;
}

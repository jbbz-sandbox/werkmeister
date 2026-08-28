/**
 * The feature lifecycle — `up`/`down`/`stop`/`restart` — as callable functions.
 *
 * These are the sequences `apps/cli/src/commands/*` used to *be*. Splitting them
 * out is what lets a caller that is not a process — the dashboard, an MCP server
 * — drive a feature without a subprocess, which is the whole point of §5 of the
 * migration design.
 *
 * The convention, so the boundary is one rule and not four:
 *
 * - the feature is always an explicit argument; nothing here reads `process.cwd()`
 *   or `process.env.FEATURE`,
 * - a failure is a `SandboxError` with a code, never a `process.exit`,
 * - progress goes through the reporter (`info`/`warn`/`error`), but banners,
 *   tables and next-step hints do not — those are the CLI's rendering, and stay
 *   in the CLI,
 * - the return value is a plain object the caller can branch on.
 *
 * `up` and `down` still live in their commands; they land here in later PRs.
 */

import { composeRestart, composeStop } from "./compose.js";
import { SandboxError } from "./errors.js";
import { info } from "./reporter.js";
import { getSlot } from "./slots.js";

/** A feature that was running, and the slot it keeps while stopped. */
export interface StopResult {
  feature: string;
  slot: number;
}

/** A feature that was running, and the slot its restarted containers reuse. */
export interface RestartResult {
  feature: string;
  slot: number;
}

/**
 * Stop *feature*'s containers, leaving them and its slot in place so
 * `restart`/`up` can resume it.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_STOP_FAILED` when `docker compose stop` reports failure.
 */
export async function stop(feature: string): Promise<StopResult> {
  const slot = await requireSlot(feature);

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  if (!composeStop(feature)) {
    throw new SandboxError(`Failed to stop containers for '${feature}'`, "COMPOSE_STOP_FAILED");
  }

  return { feature, slot };
}

/**
 * Restart *feature*'s containers in place.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_RESTART_FAILED` when `docker compose restart` reports failure.
 */
export async function restart(feature: string): Promise<RestartResult> {
  const slot = await requireSlot(feature);

  info(`Restarting containers for '${feature}' (slot ${slot})...`);
  if (!composeRestart(feature)) {
    throw new SandboxError(
      `Failed to restart containers for '${feature}'`,
      "COMPOSE_RESTART_FAILED",
    );
  }

  return { feature, slot };
}

/**
 * A feature with no slot was never brought up (or has been torn down), so there
 * is nothing to act on. Shared because both callers must raise the *same* code
 * — the CLI matches on it to print its "start it with" hint.
 */
async function requireSlot(feature: string): Promise<number> {
  const slot = await getSlot(feature);
  if (slot === null) {
    throw new SandboxError(
      `Feature '${feature}' is not running (no slot allocated)`,
      "NOT_RUNNING",
    );
  }
  return slot;
}

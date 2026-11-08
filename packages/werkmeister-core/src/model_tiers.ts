/**
 * Model tiers (SW-577): werkmeister, not the harness, picks a workspace's model.
 * `--model` takes a tier or a model; a tier resolves through `models:` in
 * ~/.werkmeister/config.yaml, merged over {@link BUILTIN_MODELS} one tier at a time.
 */

import { type GlobalConfig, loadConfig } from "./config.js";
import { WorkspaceError } from "./errors.js";

export const MODEL_TIERS = ["small", "mid", "frontier", "advanced_frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Keyed by harness id: each harness takes its own value form (OpenCode only `provider/model`). Codex has none: set `models.codex`. */
export const BUILTIN_MODELS: Record<string, Partial<Record<ModelTier, string>>> = {
  claude: {
    small: "haiku",
    mid: "sonnet",
    frontier: "opus",
    // A full id: Claude Code may have no `fable` alias, and a bad value only fails on first use.
    advanced_frontier: "claude-fable-5-1",
  },
  opencode: {
    small: "anthropic/claude-haiku-5-5",
    mid: "anthropic/claude-sonnet-5-5",
    frontier: "anthropic/claude-opus-5-5",
    advanced_frontier: "anthropic/claude-fable-5-1",
  },
  codex: {},
};

/** The generic MCP adapter never passes a model, so a tier would change nothing there. */
const UNRESOLVED_HARNESSES = new Set(["mcp"]);

const isTier = (v: string): v is ModelTier => (MODEL_TIERS as readonly string[]).includes(v);
const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type TierEntry = { model: string; origin: "YAML" | "default" } | undefined;

/** `default_tier` and each harness's merged map, every value tagged with where it came from. */
export function modelTiers(cfg: GlobalConfig = loadConfig()): {
  defaultTier: ModelTier;
  defaultOrigin: "YAML" | "default";
  byHarness: Record<string, Record<ModelTier, TierEntry>>;
} {
  const models = isDict(cfg.models) ? cfg.models : {};
  const rawDefault = models.default_tier;
  if (rawDefault !== undefined && !(typeof rawDefault === "string" && isTier(rawDefault)))
    throw new WorkspaceError(
      `models.default_tier must be one of ${MODEL_TIERS.join(", ")} (got ${String(rawDefault)})`,
    );
  const harnesses = new Set([
    ...Object.keys(BUILTIN_MODELS),
    ...Object.keys(models).filter((k) => k !== "default_tier" && isDict(models[k])),
  ]);
  const byHarness: Record<string, Record<ModelTier, TierEntry>> = {};
  for (const h of harnesses) {
    const mine = isDict(models[h]) ? models[h] : {};
    byHarness[h] = Object.fromEntries(
      MODEL_TIERS.map((t) => {
        const v = mine[t];
        if (typeof v === "string" && v.trim()) return [t, { model: v.trim(), origin: "YAML" }];
        const builtin = BUILTIN_MODELS[h]?.[t];
        return [t, builtin ? { model: builtin, origin: "default" } : undefined];
      }),
    ) as Record<ModelTier, TierEntry>;
  }
  return {
    defaultTier: (rawDefault as ModelTier | undefined) ?? "frontier",
    defaultOrigin: rawDefault === undefined ? "default" : "YAML",
    byHarness,
  };
}

/**
 * The model to record for *value* on *harness*: blank is the default tier, a tier
 * name its mapped model, anything else itself. Throws when a tier has no model for
 * the harness, never falling back to the harness's own default.
 */
export function resolveModel(
  value: string | null | undefined,
  harness: string,
  cfg?: GlobalConfig,
): { model: string | null; tier: ModelTier | null } {
  const given = (value ?? "").trim();
  if (UNRESOLVED_HARNESSES.has(harness)) return { model: given || null, tier: null };
  if (given && !isTier(given)) return { model: given, tier: null };
  const tiers = modelTiers(cfg ?? loadConfig());
  const tier = given ? (given as ModelTier) : tiers.defaultTier;
  const model = tiers.byHarness[harness]?.[tier]?.model;
  if (!model)
    throw new WorkspaceError(
      `No model for tier ${tier} on harness ${harness}: set models.${harness}.${tier} in ~/.werkmeister/config.yaml`,
    );
  return { model, tier };
}

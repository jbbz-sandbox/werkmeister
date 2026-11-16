/**
 * Token and cost reading over Claude Code transcripts, priced from
 * ~/.werkmeister/model-pricing.yaml (SW-187: the Claude harness's usage reader).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { modelPricingYamlPath } from "../../config.js";
import { warn } from "../../reporter.js";
import { isFile } from "../../tool_bins.js";
import type { ModelUsage, SessionUsage, UsageTotals, WorkspaceUsage } from "../types.js";
import { findClaudeProjectDir, listSessionFiles, readSessionTitle } from "./transcript.js";

export type { ModelUsage, SessionUsage, UsageTotals, WorkspaceUsage } from "../types.js";

export interface ModelRate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const zeroTotals = (): UsageTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
function addTotals(into: UsageTotals, t: UsageTotals): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheCreation += t.cacheCreation;
  into.cacheRead += t.cacheRead;
}

export interface SessionReduction {
  byModel: Map<string, UsageTotals>;
  firstTurn: string | null;
  lastTurn: string | null;
  turns: number;
  models: string[];
}

/**
 * Sum one session file's assistant `message.usage` by model, with its first and last
 * timestamps. Reads only the TOP-LEVEL usage fields (never `iterations[]`, which
 * itemizes a single tool-loop turn and would double-count). Unparseable lines are skipped.
 */
export function reduceSession(text: string): SessionReduction {
  const byModel = new Map<string, UsageTotals>();
  let firstTurn: string | null = null;
  let lastTurn: string | null = null;
  let turns = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: {
      type?: string;
      timestamp?: string;
      message?: { model?: string; usage?: Record<string, number> };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.timestamp === "string") {
      // ISO strings in one zone compare as times.
      if (!firstTurn || e.timestamp < firstTurn) firstTurn = e.timestamp;
      if (!lastTurn || e.timestamp > lastTurn) lastTurn = e.timestamp;
    }
    if (e.type !== "assistant") continue;
    const u = e.message?.usage;
    const model = e.message?.model;
    if (!u || !model) continue;
    turns++;
    let acc = byModel.get(model);
    if (!acc) {
      acc = zeroTotals();
      byModel.set(model, acc);
    }
    acc.input += u.input_tokens ?? 0;
    acc.output += u.output_tokens ?? 0;
    acc.cacheCreation += u.cache_creation_input_tokens ?? 0;
    acc.cacheRead += u.cache_read_input_tokens ?? 0;
  }
  return { byModel, firstTurn, lastTurn, turns, models: [...byModel.keys()] };
}

export function reduceUsageLines(text: string): Map<string, UsageTotals> {
  return reduceSession(text).byModel;
}

/** Estimate USD for one model's totals, or null when the model has no rate. */
export function estimateUsd(t: UsageTotals, rate: ModelRate | undefined): number | null {
  if (!rate) return null;
  return (
    (t.input / 1e6) * rate.input +
    (t.output / 1e6) * rate.output +
    (t.cacheCreation / 1e6) * rate.cacheWrite +
    (t.cacheRead / 1e6) * rate.cacheRead
  );
}

const DATED_MODEL_ID_RE = /-\d{8}$/;

/**
 * Resolve a model id to its price rate. Claude Code writes dated model ids in
 * transcripts (e.g. `claude-haiku-4-5-20251001`) while the price table is keyed
 * by the undated base id (`claude-haiku-4-5`) — try the exact id first, then
 * strip a trailing `-YYYYMMDD` suffix and retry. Neither form present → still
 * `undefined`, preserving "unknown model → null, never guess".
 */
export function rateFor(prices: Record<string, ModelRate>, model: string): ModelRate | undefined {
  if (prices[model]) return prices[model];
  const base = model.replace(DATED_MODEL_ID_RE, "");
  return base !== model ? prices[base] : undefined;
}

// Under ~/.werkmeister/model-pricing.yaml: a file seeded before a model shipped still prices it (SW-773).
const DEFAULT_PRICES: Record<string, ModelRate> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // shortcut: ≤100K-token prompt tier only (over 100K costs 5×); add tiers if Haiku runs main sessions.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** Locate `~/.werkmeister/model-pricing.yaml`, mirroring resolveServicesYaml. */
async function resolveModelPricingYaml(): Promise<string | null> {
  const p = modelPricingYamlPath();
  return (await isFile(p)) ? p : null;
}

export async function loadPriceTable(): Promise<Record<string, ModelRate>> {
  const p = await resolveModelPricingYaml();
  if (!p) return DEFAULT_PRICES;
  try {
    const doc = parseYaml(await fs.readFile(p, "utf-8")) as { models?: Record<string, ModelRate> };
    return { ...DEFAULT_PRICES, ...doc?.models };
  } catch {
    return DEFAULT_PRICES;
  }
}

/**
 * Sum a workspace's Claude Code token usage by model and by session, with a
 * configurable USD estimate. On-demand (no cache); reads every session file's
 * lines. Counts only sessions in the workspace-root project dir. sandbox.ts's
 * getWorkspaceUsage resolves the name; close-out's snapshot passes the folder (SW-206).
 */
export async function usageForDir(name: string, target: string): Promise<WorkspaceUsage> {
  const projectDir = await findClaudeProjectDir(target);
  const files = projectDir ? await listSessionFiles(projectDir) : []; // newest first
  const sessions: SessionTally[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await fs.readFile(f.file, "utf-8");
    } catch {
      continue;
    }
    const sessionId = path.basename(f.file, ".jsonl");
    sessions.push({
      sessionId,
      title: await readSessionTitle(f.file, sessionId),
      updatedAt: f.mtime.toISOString(),
      reduction: reduceSession(text),
    });
  }
  return rollUpUsage(name, sessions);
}

/** One session's reduced usage, the input {@link rollUpUsage} takes from any harness. */
export interface SessionTally {
  sessionId: string;
  title: string;
  updatedAt: string;
  reduction: SessionReduction;
}

const warnedUnpriced = new Set<string>();

/** A workspace's sessions summed by model and by session, priced from the price table. */
export async function rollUpUsage(name: string, tallies: SessionTally[]): Promise<WorkspaceUsage> {
  const prices = await loadPriceTable();
  // An unpriced model left every cost null unnoticed for weeks (SW-773). Zero-token
  // rows (Claude Code's `<synthetic>` error turns) cost nothing, so they don't warn.
  for (const [model, t] of tallies.flatMap((s) => [...s.reduction.byModel])) {
    if (!(t.input + t.output + t.cacheCreation + t.cacheRead)) continue;
    if (rateFor(prices, model) || warnedUnpriced.has(model)) continue;
    warnedUnpriced.add(model);
    warn(`No price for model ${model}: its cost is unknown. Add it to ${modelPricingYamlPath()}.`);
  }
  const wsByModel = new Map<string, UsageTotals>();
  const sessions: SessionUsage[] = [];

  for (const { sessionId, title, updatedAt, reduction: session } of tallies) {
    const perModel = session.byModel;
    if (!perModel.size) continue;
    const sessionTotals = zeroTotals();
    let sessionUsd: number | null = null;
    for (const [model, t] of perModel) {
      let acc = wsByModel.get(model);
      if (!acc) {
        acc = zeroTotals();
        wsByModel.set(model, acc);
      }
      addTotals(acc, t);
      addTotals(sessionTotals, t);
      const usd = estimateUsd(t, rateFor(prices, model));
      if (usd != null) sessionUsd = (sessionUsd ?? 0) + usd;
    }
    sessions.push({
      sessionId,
      title,
      updatedAt,
      firstTurn: session.firstTurn,
      lastTurn: session.lastTurn,
      turns: session.turns,
      models: session.models,
      totals: sessionTotals,
      estUsd: sessionUsd,
    });
  }

  const byModel: ModelUsage[] = [...wsByModel].map(([model, totals]) => ({
    model,
    totals,
    estUsd: estimateUsd(totals, rateFor(prices, model)),
  }));
  const totals = zeroTotals();
  let estUsd: number | null = null;
  for (const m of byModel) {
    addTotals(totals, m.totals);
    if (m.estUsd != null) estUsd = (estUsd ?? 0) + m.estUsd;
  }
  byModel.sort(
    (a, b) =>
      (b.estUsd ?? 0) - (a.estUsd ?? 0) ||
      b.totals.input + b.totals.output - (a.totals.input + a.totals.output),
  );

  return { name, totals, estUsd, byModel, sessions };
}

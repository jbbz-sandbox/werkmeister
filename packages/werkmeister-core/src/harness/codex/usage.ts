/**
 * Token usage over Codex rollouts (SW-384), priced like Claude's from
 * ~/.werkmeister/model-pricing.yaml; a model with no row there has no USD estimate.
 */
import fs from "node:fs/promises";
import { rollUpUsage, type SessionReduction, type SessionTally } from "../claude/usage.js";
import type { UsageTotals, WorkspaceUsage } from "../types.js";
import { codexSessionsIn, codexSessionTitle } from "./transcript.js";

/**
 * One rollout's usage: the last `token_count` event holds the session's running total
 * (`input_tokens` includes the cached part). Model from the last `turn_context`.
 */
export function reduceCodexSession(text: string): SessionReduction {
  let total: Record<string, number> | null = null;
  let model = "unknown";
  let firstTurn: string | null = null;
  let lastTurn: string | null = null;
  let turns = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; timestamp?: string; payload?: Record<string, any> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.timestamp === "string") {
      if (!firstTurn || e.timestamp < firstTurn) firstTurn = e.timestamp;
      if (!lastTurn || e.timestamp > lastTurn) lastTurn = e.timestamp;
    }
    const p = e.payload;
    if (e.type === "turn_context" && typeof p?.model === "string") model = p.model;
    if (e.type === "event_msg" && p?.type === "token_count" && p.info?.total_token_usage) {
      total = p.info.total_token_usage;
      turns++;
    }
  }
  const byModel = new Map<string, UsageTotals>();
  if (total) {
    const cached = total.cached_input_tokens ?? 0;
    byModel.set(model, {
      input: (total.input_tokens ?? 0) - cached,
      output: total.output_tokens ?? 0,
      cacheCreation: total.cache_write_input_tokens ?? 0,
      cacheRead: cached,
    });
  }
  return { byModel, firstTurn, lastTurn, turns, models: [...byModel.keys()] };
}

export async function codexUsageForDir(name: string, dir: string): Promise<WorkspaceUsage> {
  const tallies: SessionTally[] = [];
  for (const s of await codexSessionsIn(dir)) {
    const text = await fs.readFile(s.file, "utf-8").catch(() => null);
    if (text === null) continue;
    tallies.push({
      sessionId: s.id,
      title: await codexSessionTitle(s.file, s.id),
      updatedAt: s.mtime.toISOString(),
      reduction: reduceCodexSession(text),
    });
  }
  return rollUpUsage(name, tallies);
}

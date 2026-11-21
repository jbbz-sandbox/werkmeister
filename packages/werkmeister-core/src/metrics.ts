/**
 * The metrics event log (SW-775, design SW-772 § Q3, Q4): `~/.werkmeister/metrics/events-YYYY-MM.jsonl`,
 * append-only, local only, kept forever. One line per event, shaped by
 * `docs/superpowers/specs/2026-11-15-metrics-events.schema.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxHome } from "./config.js";
import { warn } from "./reporter.js";

export type MetricsEvent =
  | { event: "queue.wait"; workspace: string; feature: string; position: number }
  | { event: "queue.admit"; workspace: string; feature: string; waited_s: number };

/** `<sandboxHome()>/metrics/events-YYYY-MM.jsonl`, the UTC month of *at* (an ISO time). */
export function metricsPath(at: string): string {
  return path.join(sandboxHome(), "metrics", `events-${at.slice(0, 7)}.jsonl`);
}

/** Appends *e* to this month's log. A failure warns and never throws: a lost metric must not fail its caller. */
export function recordEvent(e: MetricsEvent, at = new Date().toISOString()): void {
  const file = metricsPath(at);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One appendFileSync is one write() on an O_APPEND file, so concurrent writers' lines don't interleave.
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, at, ...e })}\n`);
  } catch (err) {
    warn(`metrics: could not record ${e.event}: ${(err as Error).message}`);
  }
}

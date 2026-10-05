/**
 * Shared, dependency-free usage breakdown renderer. Mounted by both the
 * Workspaces tab (workspace-ui.ts) and the Health tab (health-ui.ts) under a
 * "Usage" button. Shape mirrors the workspace-usage tool's structuredContent
 * (UI code can't import the server lib, so the type is duplicated here).
 */
import { el, injectCss } from "./theme.js";

export interface UsageTotals { input: number; output: number; cacheCreation: number; cacheRead: number; }
export interface ModelUsage { model: string; totals: UsageTotals; estUsd: number | null; }
export interface SessionUsage { sessionId: string; title: string; updatedAt: string; totals: UsageTotals; estUsd: number | null; }
export interface WorkspaceUsage { name: string; totals: UsageTotals; estUsd: number | null; byModel: ModelUsage[]; sessions: SessionUsage[]; }

// The .usage-panel container (padding, separators) stays with each host's own
// CSS — these are just the rows inside it, shared by both hosts.
const CSS = `
  .usage-total { display: flex; gap: 12px; font-weight: 600; margin-bottom: 6px; }
  .usage-h { font-weight: 600; margin: 6px 0 2px; color: var(--sd-muted); }
  .usage-row { display: flex; gap: 12px; align-items: baseline; padding: 1px 0; }
  .usage-row.sub { padding-left: 10px; color: var(--sd-muted); }
  .usage-name { min-width: 160px; }
  .usage-usd { min-width: 64px; text-align: right; }
  .usage-tok { min-width: 80px; text-align: right; color: var(--sd-muted); }
  .usage-split { color: var(--sd-faint); font-size: 11px; }
  .usage-empty { color: var(--sd-faint); }
`;

const sum = (t: UsageTotals): number => t.input + t.output + t.cacheCreation + t.cacheRead;

function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
const fmtUsd = (v: number | null): string => (v == null ? "—" : "~$" + v.toFixed(2));

export function renderUsage(container: HTMLElement, usage: WorkspaceUsage): void {
  injectCss("usage", CSS);
  container.innerHTML = "";
  container.classList.add("usage");
  if (!usage.sessions.length) {
    container.appendChild(el("div", "usage-empty", "No usage recorded for this workspace yet."));
    return;
  }

  // Grand total.
  const head = el("div", "usage-total");
  head.appendChild(el("span", "usage-usd", fmtUsd(usage.estUsd)));
  head.appendChild(el("span", "usage-tok", fmtTokens(sum(usage.totals)) + " tok"));
  container.appendChild(head);

  // Per-model.
  container.appendChild(el("div", "usage-h", "By model"));
  for (const m of usage.byModel) {
    const row = el("div", "usage-row");
    row.appendChild(el("span", "usage-name", m.model));
    row.appendChild(el("span", "usage-usd", fmtUsd(m.estUsd)));
    row.appendChild(el("span", "usage-tok", fmtTokens(sum(m.totals)) + " tok"));
    row.appendChild(el("span", "usage-split",
      `in ${fmtTokens(m.totals.input)} · out ${fmtTokens(m.totals.output)} · cache-r ${fmtTokens(m.totals.cacheRead)}`));
    container.appendChild(row);
  }

  // Per-session (newest first). Flag the costliest session as "hot".
  const hottest = usage.sessions.reduce((a, b) => ((b.estUsd ?? 0) > (a.estUsd ?? 0) ? b : a), usage.sessions[0]);
  container.appendChild(el("div", "usage-h", `Sessions (${usage.sessions.length})`));
  for (const s of usage.sessions) {
    const row = el("div", "usage-row sub");
    row.appendChild(el("span", "usage-name", s.title || s.sessionId.slice(0, 8)));
    row.appendChild(el("span", "usage-usd", fmtUsd(s.estUsd)));
    row.appendChild(el("span", "usage-tok", fmtTokens(sum(s.totals)) + " tok"));
    if (s === hottest && (s.estUsd ?? 0) > 0) row.appendChild(el("span", "usage-hot", "🔥"));
    container.appendChild(row);
  }
}

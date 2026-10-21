/**
 * The usage breakdown both the Workspaces tab (workspace-ui.tsx) and the Health tab
 * (health-ui.tsx) show under a "Usage" button. Shape mirrors the workspace-usage
 * tool's structuredContent (UI code can't import the server lib, so the type is
 * duplicated here).
 */
import { Css } from "./style.js";

export interface UsageTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}
export interface ModelUsage {
  model: string;
  totals: UsageTotals;
  estUsd: number | null;
}
export interface SessionUsage {
  sessionId: string;
  title: string;
  updatedAt: string;
  totals: UsageTotals;
  estUsd: number | null;
}
export interface WorkspaceUsage {
  name: string;
  totals: UsageTotals;
  estUsd: number | null;
  byModel: ModelUsage[];
  sessions: SessionUsage[];
}

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

export function Usage({ usage }: { usage: WorkspaceUsage }) {
  if (!usage.sessions.length)
    return (
      <>
        <Css id="usage" css={CSS} />
        <div className="usage-empty">No usage recorded for this workspace yet.</div>
      </>
    );
  // Flag the costliest session as "hot".
  const hottest = usage.sessions.reduce(
    (a, b) => ((b.estUsd ?? 0) > (a.estUsd ?? 0) ? b : a),
    usage.sessions[0],
  );
  return (
    <>
      <Css id="usage" css={CSS} />
      <div className="usage-total">
        <span className="usage-usd">{fmtUsd(usage.estUsd)}</span>
        <span className="usage-tok">{fmtTokens(sum(usage.totals))} tok</span>
      </div>
      <div className="usage-h">By model</div>
      {usage.byModel.map((m) => (
        <div className="usage-row" key={m.model}>
          <span className="usage-name">{m.model}</span>
          <span className="usage-usd">{fmtUsd(m.estUsd)}</span>
          <span className="usage-tok">{fmtTokens(sum(m.totals))} tok</span>
          <span className="usage-split">
            in {fmtTokens(m.totals.input)} · out {fmtTokens(m.totals.output)} · cache-r{" "}
            {fmtTokens(m.totals.cacheRead)}
          </span>
        </div>
      ))}
      <div className="usage-h">Sessions ({usage.sessions.length})</div>
      {usage.sessions.map((s) => (
        <div className="usage-row sub" key={s.sessionId}>
          <span className="usage-name">{s.title || s.sessionId.slice(0, 8)}</span>
          <span className="usage-usd">{fmtUsd(s.estUsd)}</span>
          <span className="usage-tok">{fmtTokens(sum(s.totals))} tok</span>
          {s === hottest && (s.estUsd ?? 0) > 0 && <span className="usage-hot">🔥</span>}
        </div>
      ))}
    </>
  );
}

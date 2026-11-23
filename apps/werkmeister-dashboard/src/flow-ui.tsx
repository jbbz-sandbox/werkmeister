/**
 * "Flow" dashboard tab (SW-782, design SW-772 § Q5): the flow board from the `metrics` tool, with
 * each card's age and wait, red past its column's p90. Card → workspace timeline → session row →
 * the session picker (the shared chat panel). Inline SVG; the repo has no chart dependency.
 */

import { useEffect, useState } from "react";
import type { MetricsRange, MetricsReport, TimelineEvent } from "werkmeister-core/metrics_report";
import { ChatPanel } from "werkmeister-ui/chat-panel";
import { renderMarkdown } from "werkmeister-ui/lib/markdown";
import { Css } from "werkmeister-ui/theme";
import type { SessionUsage } from "werkmeister-ui/usage-widget";
import type { HostBridge } from "werkmeister-ui/workspace-ui";
import { COLUMN_LABEL, cardView, formatMinutes, timelineView } from "./lib/flow-board.js";

/** A `workspace-usage` session row; the tool also returns these, the shared widget type omits them. */
type Session = SessionUsage & { firstTurn: string | null; lastTurn: string | null; turns: number };

const RANGES: [MetricsRange, string][] = [
  ["7d", "7d"],
  ["30d", "30d"],
  ["90d", "90d"],
  ["all", "All"],
];

const CSS = `
  .flow, .flow * { box-sizing: border-box; }
  .flow { font-family: var(--sd-sans); color: var(--sd-ink); padding: 16px 20px 40px; }
  .flow .ranges { display: flex; gap: 6px; margin: 4px 0 12px; padding: 0; border: 0; min-width: 0; }
  .flow .ranges button, .flow .sess {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--sd-ink);
    padding: 6px 12px; border: 1px solid var(--sd-ctl); border-radius: 8px; background: var(--sd-card);
  }
  .flow .ranges button[aria-pressed="true"] { background: var(--sd-accent); border-color: var(--sd-accent); color: var(--sd-on-accent); }
  .flow .load-status { color: var(--sd-muted); font-size: 13px; min-height: 1em; margin-bottom: 8px; }
  .flow .load-status.err { color: var(--sd-err); }
  .flow .board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 640px) { .flow .board { grid-template-columns: 1fr; } }
  .flow .col { background: var(--sd-hover); border: 1px solid var(--sd-line); border-radius: 10px; padding: 8px; min-width: 0; }
  .flow .col-h { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--sd-muted); margin: 2px 4px 8px; }
  .flow .empty { color: var(--sd-faint); font-size: 12px; margin: 4px; }
  .flow .card {
    display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; color: var(--sd-ink); cursor: pointer;
    background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px;
  }
  .flow .card.red { border-color: var(--sd-err-bd); background: var(--sd-err-bg); }
  .flow .card.sel { outline: 2px solid var(--sd-accent); }
  .flow .card .t { font-weight: 600; overflow-wrap: anywhere; }
  .flow .card .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; color: var(--sd-muted); font-size: 12px; }
  .flow .chip { border: 1px solid var(--sd-line); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
  .flow .badge { border-radius: 999px; padding: 1px 7px; font-size: 11px; background: var(--sd-warn-bg); border: 1px solid var(--sd-warn-bd); color: var(--sd-ink); }
  .flow .detail { margin-top: 20px; }
  .flow .detail h3 { font-size: 14px; margin: 0 0 8px; }
  .flow .tl { display: flex; gap: 8px; background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 8px; padding: 6px 8px; }
  .flow .tl-labels { display: flex; flex-direction: column; flex: none; }
  .flow .tl-labels span { height: 20px; line-height: 20px; font-size: 11px; color: var(--sd-muted); }
  .flow .tl svg { flex: 1; min-width: 0; height: 80px; display: block; }
  .flow .sessions { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .flow .sess { text-align: left; font-weight: 400; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .flow .sess[aria-pressed="true"] { border-color: var(--sd-accent); }
  .flow .sess b { font-weight: 600; }
`;

const ROWS = ["stage", "wait", "gate", "pr"] as const;
const FILL: Record<(typeof ROWS)[number], string> = {
  stage: "var(--sd-accent)",
  wait: "var(--sd-warn)",
  gate: "var(--sd-ok)",
  pr: "var(--sd-pr)",
};

function Timeline({ events }: { events: TimelineEvent[] }) {
  const { start, end, bars } = timelineView(events, new Date());
  if (!bars.length) return <div className="empty">No events logged for this run yet.</div>;
  // Stretched to the pane's width at a fixed height, so text never scales: the labels are HTML.
  const x = (t: number) => ((t - start) / Math.max(end - start, 1)) * 1000;
  return (
    <div className="tl">
      <div className="tl-labels" aria-hidden="true">
        {ROWS.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
      <svg
        viewBox="0 0 1000 80"
        preserveAspectRatio="none"
        role="img"
        aria-label="Workspace timeline: stages, waits, gate runs and PR"
      >
        {bars.map((b, i) => {
          const nthStage = bars.slice(0, i).filter((s) => s.kind === "stage").length;
          const point = b.from === b.to;
          return (
            <rect
              key={`${b.kind}${b.from}${b.label}`}
              x={point ? x(b.from) - 4 : x(b.from)}
              y={4 + ROWS.indexOf(b.kind) * 20}
              width={point ? 8 : Math.max(x(b.to) - x(b.from), 3)}
              height={12}
              fill={b.fail ? "var(--sd-err)" : FILL[b.kind]}
              opacity={b.kind === "stage" && nthStage % 2 ? 0.65 : 1}
            >
              <title>
                {point
                  ? `${b.label} ${new Date(b.from).toLocaleString()}`
                  : `${b.label}: ${formatMinutes((b.to - b.from) / 60000)}`}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

function Detail({
  bridge,
  workspace,
  active,
}: {
  bridge: HostBridge;
  workspace: string;
  active: boolean;
}) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [usage, setUsage] = useState<{ sessions: Session[] } | null>(null);
  const [err, setErr] = useState("");
  const [session, setSession] = useState<string>();
  // The timeline is the whole run, so a range click doesn't refetch it; showing the tab again
  // does, so its open bars reach now (SW-1094).
  useEffect(() => {
    if (!active) return;
    let stale = false;
    Promise.all([
      bridge.callTool("metrics", { workspace }) as Promise<MetricsReport>,
      bridge.callTool("workspace-usage", { workspace }) as Promise<{ sessions: Session[] }>,
    ]).then(
      ([m, u]) => {
        if (stale) return;
        setErr("");
        setEvents(m.timeline ?? []);
        setUsage(u);
      },
      (e: Error) => !stale && setErr(`Couldn't load ${workspace}: ${e.message}`),
    );
    return () => {
      stale = true;
    };
  }, [bridge, workspace, active]);
  return (
    <section className="detail" aria-label={`${workspace} timeline`}>
      <h3>{workspace}</h3>
      {err && <div className="load-status err">{err}</div>}
      {events ? <Timeline events={events} /> : !err && <div className="load-status">Loading…</div>}
      <div className="sessions">
        {usage?.sessions.map((s) => (
          <button
            key={s.sessionId}
            type="button"
            className="sess"
            aria-pressed={session === s.sessionId}
            onClick={() => setSession(s.sessionId)}
          >
            <b>{s.title || s.sessionId.slice(0, 8)}</b>
            <span>
              {s.firstTurn ? new Date(s.firstTurn).toLocaleString() : "—"} →{" "}
              {s.lastTurn ? new Date(s.lastTurn).toLocaleString() : "—"}
            </span>
            <span>{s.turns} turns</span>
            <span>
              {(
                s.totals.input +
                s.totals.output +
                s.totals.cacheCreation +
                s.totals.cacheRead
              ).toLocaleString()}{" "}
              tokens
            </span>
            {s.estUsd != null && <span>${s.estUsd.toFixed(2)}</span>}
          </button>
        ))}
      </div>
      {session && (
        <ChatPanel
          key={session}
          name={workspace}
          bridge={bridge}
          renderMarkdown={renderMarkdown}
          initialSessionId={session}
        />
      )}
    </section>
  );
}

/** `active`: the Flow tab is the one on screen. */
export function FlowTab({ bridge, active }: { bridge: HostBridge; active: boolean }) {
  const [range, setRange] = useState<MetricsRange>("7d");
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [status, setStatus] = useState({ text: "Loading…", err: false });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setStatus({ text: "Loading…", err: false });
    (bridge.callTool("metrics", { range }) as Promise<MetricsReport>).then(
      (r) => {
        if (stale) return;
        setReport(r);
        setStatus({ text: "", err: false });
      },
      (e: Error) =>
        !stale && setStatus({ text: `Couldn't load the flow board: ${e.message}`, err: true }),
    );
    return () => {
      stale = true;
    };
  }, [bridge, range]);

  return (
    <div className="flow">
      <Css id="wsd-flow" css={CSS} />
      <fieldset className="ranges" aria-label="Range">
        {RANGES.map(([r, label]) => (
          <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
            {label}
          </button>
        ))}
      </fieldset>
      <div className={status.err ? "load-status err" : "load-status"}>{status.text}</div>
      {report && (
        <div className="board">
          {report.board.map((col) => (
            <div key={col.column} className="col">
              <div className="col-h">
                {COLUMN_LABEL[col.column]} · {col.wip}
              </div>
              {col.cards.length === 0 && <div className="empty">Nothing here</div>}
              {col.cards.map((c) => {
                const v = cardView(c);
                const cls = ["card", v.red && "red", selected === c.workspace && "sel"]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    key={c.workspace}
                    type="button"
                    className={cls}
                    aria-label={`${v.title}, ${v.age} in ${COLUMN_LABEL[col.column]}${v.red ? ", past p90" : ""}${v.badge ? `, waiting ${v.badge}` : ""}`}
                    onClick={() => setSelected(c.workspace)}
                  >
                    <div className="t">{v.title}</div>
                    <div className="meta">
                      {v.stage && <span className="chip">{v.stage}</span>}
                      <span>{v.age}</span>
                      {v.badge && <span className="badge">{v.badge}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {selected && <Detail key={selected} bridge={bridge} workspace={selected} active={active} />}
    </div>
  );
}

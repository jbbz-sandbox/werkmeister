/**
 * The handoff workspace card (docs/design/workspace-card, SW-53): header with the
 * agent chip and last question, the Containers / PRs / Workflow / Agent rows, the
 * action bar with its ⋯ menu, and the inline Close out / Abandon… confirms.
 *
 * Presentational only: data arrives as a display model, every side effect goes out
 * through `onAction` / `onOpenLink`, and its panels come from `renderPanel`. It imports
 * nothing that touches the DOM at load, so `react-dom/server` can render it under plain
 * `node` in tests. Its styles are `CARD_CSS`, added by workspace-ui.tsx; colours are
 * tokens only.
 */

import { type ReactNode, useState } from "react";
import type { DisplayInput, Tone, WorkspaceDisplay } from "./display-model.js";

export type PanelKind = "chat" | "usage" | "logs";
export type CardAction =
  | "continue"
  | "continue-desktop"
  | "new-session"
  | "up"
  | "stop"
  | "restart"
  | "down"
  | "refresh-prs"
  | "open-feature"
  | "open-issue"
  | "open-vscode"
  | "close-out"
  | "abandon"
  | "retry-status"
  | PanelKind;
export type ContainerState = DisplayInput["state"];

export interface Btn {
  label: string;
  action: CardAction;
}

export interface CardProps {
  name: string;
  /** The workspace folder, for `↗ Continue in Desktop`. */
  path: string;
  task: string | null;
  workType: string | null;
  issueId: string | null;
  issueUrl: string | null;
  /** null until the first `status` lands: the card shows its skeleton. */
  display: WorkspaceDisplay | null;
  state: ContainerState | null;
  prsLoading: boolean;
  /** "Stopping…" while an action runs; the bar is disabled meanwhile. */
  busy: string | null;
  error: string | null;
  /** `abandon` carries the reason. */
  onAction(action: CardAction, reason?: string): void;
  onOpenLink(url: string): void;
  /** The open panel's content (chat, usage, logs). It mounts fresh each time the panel opens. */
  renderPanel(kind: PanelKind): ReactNode;
}

const CONTINUE: Btn = { label: "↗ Continue in Terminal", action: "continue" };
const CONTINUE_DESKTOP: Btn = { label: "↗ Continue in Desktop", action: "continue-desktop" };
const NEW_SESSION: Btn = { label: "＋ New session", action: "new-session" };
const UP: Btn = { label: "▶ Up", action: "up" };
const STOP: Btn = { label: "■ Stop", action: "stop" };
const RESTART: Btn = { label: "↻ Restart", action: "restart" };
const DOWN: Btn = { label: "⏻ Down", action: "down" };
const PANELS: Btn[] = [
  { label: "Chat", action: "chat" },
  { label: "Usage", action: "usage" },
  { label: "Open in VS Code", action: "open-vscode" },
];
const OVERFLOW: Btn[] = [
  { label: "↻ Refresh PRs", action: "refresh-prs" },
  { label: "Open feature ↗", action: "open-feature" },
  { label: "Open issue ↗", action: "open-issue" },
  { label: "Logs", action: "logs" },
];

/** The two secondary buttons and the card-specific ⋯ extras (design/data.js, ui-spec § Actions). */
export function barFor(
  d: WorkspaceDisplay,
  state: ContainerState | null,
): { secondary: Btn[]; extra: Btn[] } {
  const primary = d.primary.action;
  const running = state === "up" || state === "partial";
  const secondary =
    primary === "close-out"
      ? [RESTART, DOWN]
      : running
        ? [STOP, RESTART]
        : [...[UP, CONTINUE].filter((b) => b.action !== primary), NEW_SESSION];
  const shown = new Set<CardAction>([primary, ...secondary.map((b) => b.action)]);
  const extra = [CONTINUE, CONTINUE_DESKTOP, DOWN, NEW_SESSION].filter(
    (b) => !shown.has(b.action) && (b !== DOWN || running),
  );
  return { secondary, extra: [...extra, ...PANELS] };
}

/**
 * The Desktop link for a workspace folder, the one the app's "New Claude Code Session Here" service opens.
 * ponytail: opens the folder, not the workspace's last Desktop session; that session's own link needs its
 * app id, which only the pane can read (list_sessions). Pass it through status if that ever reaches core.
 */
export function desktopLink(path: string): string {
  return `claude://code/new?folder=${encodeURIComponent(path)}&source=services`;
}

const TOOLS: Partial<Record<CardAction, { tool: string; verb: string }>> = {
  continue: { tool: "claude-resume", verb: "Opening Terminal" },
  "new-session": { tool: "claude-resume", verb: "Opening Terminal" },
  up: { tool: "up", verb: "Starting" },
  stop: { tool: "stop", verb: "Stopping" },
  restart: { tool: "restart", verb: "Restarting" },
  down: { tool: "down", verb: "Tearing down" },
  "open-feature": { tool: "open-feature", verb: "Opening" },
  "open-vscode": { tool: "open-workspace", verb: "Opening" },
  "close-out": { tool: "close-out", verb: "Closing out" },
  abandon: { tool: "close-out", verb: "Abandoning" },
};

/** The MCP tool call behind a card action; null for actions that call none, and for an abandon without a reason. */
export function toolCall(
  action: CardAction,
  workspace: string,
  reason?: string,
): { tool: string; verb: string; args: Record<string, unknown> } | null {
  const t = TOOLS[action];
  if (!t) return null;
  if (action === "abandon") {
    const why = reason?.trim();
    return why ? { ...t, args: { workspace, abandon: why } } : null;
  }
  return { ...t, args: { workspace, ...(action === "new-session" ? { new: true } : {}) } };
}

const isPanel = (a: CardAction): a is PanelKind => a === "chat" || a === "usage" || a === "logs";

function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot t-${tone}`} aria-hidden="true" />;
}

function Retry({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="link" onClick={onClick}>
      retry
    </button>
  );
}

export function ConfirmFooter(p: {
  kind: "close-out" | "abandon";
  name: string;
  reason: string;
  onReason(v: string): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancel = (
    <button type="button" className="btn" onClick={p.onCancel}>
      Cancel
    </button>
  );
  if (p.kind === "close-out")
    return (
      <footer className="confirm close-out">
        <div>
          <div className="confirm-title">Close out {p.name}?</div>
          <div className="confirm-line">
            Moves the issue to Done, writes closeout.md, removes the workspace and deletes the
            merged branches.
          </div>
        </div>
        <div className="confirm-btns">
          <button type="button" className="btn destructive" onClick={p.onConfirm}>
            ✓ Yes, close out
          </button>
          {cancel}
        </div>
      </footer>
    );
  const ready = p.reason.trim() !== "";
  return (
    <footer className="confirm abandon">
      <div>
        <div className="confirm-title">Abandon {p.name}?</div>
        <div className="confirm-line">
          Posts the reason on the issue and marks it abandoned, then removes the workspace. Every
          branch is pushed and kept.
        </div>
      </div>
      <label className="reason">
        Reason (required)
        <input
          value={p.reason}
          required
          placeholder="e.g. superseded by SW-60"
          onChange={(e) => p.onReason(e.target.value)}
        />
      </label>
      <div className="confirm-btns">
        <button type="button" className="btn abandon-yes" disabled={!ready} onClick={p.onConfirm}>
          ✕ Yes, abandon
        </button>
        {cancel}
      </div>
    </footer>
  );
}

/** One row's value while it loads (rule 7: cards don't jump). */
function Loading({ width }: { width: string }) {
  return (
    <div className="val">
      <span className={`sk ${width}`} />
      <span className="loading">loading</span>
    </div>
  );
}

export function CardSkeleton({ name }: { name: string }) {
  return (
    <article className="ws-card" aria-busy="true">
      <header className="ws-head">
        <div className="ws-row1">
          <span className="ws-name">{name}</span>
          <span className="sk sk-chip" />
        </div>
        <div className="ws-row2">
          <span className="sk sk-tag" />
          <span className="sk sk-title" />
        </div>
      </header>
      <div className="ws-rows">
        <span className="lbl">Containers</span>
        <Loading width="w84" />
        <span className="lbl">PRs</span>
        <Loading width="w140" />
        <span className="lbl">Workflow</span>
        <Loading width="w180" />
        <span className="lbl">Agent</span>
        <Loading width="w110" />
      </div>
      <footer className="bar">
        <span className="sk w160 h30" />
        <span className="sk w72 h30" />
        <span className="sk w72 h30" />
        <span className="spacer" />
        <span className="sk w30 h30" />
      </footer>
    </article>
  );
}

export function WorkspaceCard(p: CardProps) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<"close-out" | "abandon" | null>(null);
  const [reason, setReason] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const d = p.display;
  if (!d) return <CardSkeleton name={p.name} />;

  const run = (a: CardAction) => {
    setMenu(false);
    if (isPanel(a)) setPanel(panel === a ? null : a);
    else if (a === "close-out" || a === "abandon") setConfirm(a);
    else if (a === "open-issue") {
      if (p.issueUrl) p.onOpenLink(p.issueUrl);
    } else if (a === "continue-desktop") p.onOpenLink(desktopLink(p.path));
    else p.onAction(a);
  };
  const cancel = () => {
    setConfirm(null);
    setReason("");
  };
  const { secondary, extra } = barFor(d, p.state);
  const primaryBtn = (
    <button
      type="button"
      className={`btn primary${d.primary.destructive ? " destructive" : ""}`}
      disabled={!!p.busy}
      onClick={() => run(d.primary.action)}
    >
      {d.primary.label}
    </button>
  );

  return (
    <article className={`ws-card${d.needs ? " attn" : ""}`}>
      <header className="ws-head">
        <div className="ws-row1">
          <span className="ws-name">{p.name}</span>
          <span className="ws-chips">
            <span className={`chip t-${d.agent.tone}`}>{d.agent.label}</span>
            {d.autonomous && <span className="auto">{d.autonomous.full}</span>}
          </span>
        </div>
        {(p.workType || p.task) && (
          <div className="ws-row2">
            {p.workType && (
              <span className="type-tag">{p.workType === "bugfix" ? "Bug" : p.workType}</span>
            )}
            {p.task && <span className="ws-title">{p.task}</span>}
          </div>
        )}
        <div className="ws-row3">
          {p.issueId && p.issueUrl ? (
            <button type="button" className="link" onClick={() => run("open-issue")}>
              {p.issueId}
            </button>
          ) : (
            <span className={p.issueId ? "" : "faint"}>{p.issueId ?? "no issue"}</span>
          )}
        </div>
        {d.needs &&
          d.question &&
          (questionOpen ? (
            <div className="question open">
              <div className="q-meta">
                <span className="q-label">Last question</span>
                <span className="muted">{d.agent.time}</span>
                <span className="spacer" />
                <button type="button" className="q-toggle" onClick={() => setQuestionOpen(false)}>
                  Hide ▴
                </button>
              </div>
              <p className="q-text">“{d.question}”</p>
              {primaryBtn}
            </div>
          ) : (
            <button type="button" className="question" onClick={() => setQuestionOpen(true)}>
              <span className="q-label">Last question</span>
              <span className="q-clip">“{d.question}”</span>
              <span className="muted">Show ▾</span>
            </button>
          ))}
      </header>

      <div className="ws-rows">
        <span className="lbl">Containers</span>
        <div className="val">
          {p.state === "unknown" ? (
            <span className="muted">
              Docker unreachable · <Retry onClick={() => p.onAction("retry-status")} />
            </span>
          ) : (
            <>
              <span className="sum">
                <Dot tone={d.containers.tone} />
                {d.containers.text}
              </span>
              {d.services.map((s) => (
                <span
                  key={s.name}
                  className={`svc t-${s.tone}${s.tone === "err" || s.tone === "warn" ? " hot" : ""}`}
                >
                  <span className="g">{s.glyph}</span> {s.text.slice(s.glyph.length + 1)}
                </span>
              ))}
            </>
          )}
        </div>

        <span className="lbl">PRs</span>
        {p.prsLoading ? (
          <Loading width="w140" />
        ) : (
          <div className="val col">
            {d.prs.map((pr) => (
              <div className="pr" key={pr.url}>
                <button type="button" className="link pr-ref" onClick={() => p.onOpenLink(pr.url)}>
                  {pr.ref}
                </button>
                <span className={`badge t-${pr.state.tone}${pr.state.dashed ? " dashed" : ""}`}>
                  {pr.state.text}
                </span>
                {pr.ci && (
                  <span className={`ci t-${pr.ci.tone}`}>
                    <span className="ci-dot" aria-hidden="true" />
                    {pr.ci.text}
                  </span>
                )}
              </div>
            ))}
            {d.prsEmpty &&
              (d.prsEmpty.tone === "warn" ? (
                <span className="unavailable">
                  {d.prsEmpty.text} · <Retry onClick={() => p.onAction("refresh-prs")} />
                </span>
              ) : (
                <span className="muted">{d.prsEmpty.text}</span>
              ))}
          </div>
        )}

        <span className="lbl">Workflow</span>
        <div className="val">
          <span className={d.workflow.kind === "lifecycle" ? "wf strong" : "wf"}>
            {d.workflow.text || "—"}
          </span>
          {d.workflow.pips.length > 0 && (
            <span className="pips" aria-hidden="true">
              {d.workflow.pips.map((pip, i) => (
                <span key={i} className={`pip ${pip}`} />
              ))}
            </span>
          )}
        </div>

        <span className="lbl">Agent</span>
        <div className="val">
          <span className={`agent${d.needs ? " needs" : ""}`}>
            <Dot tone={d.agent.dot} />
            {d.agent.word}
          </span>
          <span className="muted small">{d.agent.time}</span>
        </div>
      </div>

      {confirm ? (
        <ConfirmFooter
          kind={confirm}
          name={p.name}
          reason={reason}
          onReason={setReason}
          onCancel={cancel}
          onConfirm={() => {
            p.onAction(confirm, confirm === "abandon" ? reason.trim() : undefined);
            cancel();
          }}
        />
      ) : (
        <footer className="bar">
          {primaryBtn}
          {secondary.map((b) => (
            <button
              type="button"
              key={b.action}
              className="btn"
              disabled={!!p.busy}
              onClick={() => run(b.action)}
            >
              {b.label}
            </button>
          ))}
          <span className="spacer" />
          {(p.busy || p.error) && (
            <span className={p.error ? "act-msg err" : "act-msg"}>{p.error ?? p.busy}</span>
          )}
          <button
            type="button"
            className={`btn more${menu ? " open" : ""}`}
            aria-label="More actions"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </button>
          {menu && (
            <div className="menu" role="menu">
              {[...extra, ...OVERFLOW].map((b) => (
                <button
                  type="button"
                  role="menuitem"
                  key={b.action}
                  className={b.action === extra[extra.length - 1]?.action ? "item sep" : "item"}
                  disabled={b.action === "open-issue" && !p.issueUrl}
                  onClick={() => run(b.action)}
                >
                  {b.label}
                </button>
              ))}
              <div className="divider" />
              <button
                type="button"
                role="menuitem"
                className="item abandon"
                onClick={() => run("abandon")}
              >
                ✕ Abandon…
              </button>
            </div>
          )}
        </footer>
      )}
      {panel && (
        <div key={panel} className={`ws-panel panel-${panel}`}>
          {p.renderPanel(panel)}
        </div>
      )}
    </article>
  );
}

/** Tone → the fg/bg/bd triple every toned element reads (design/data.js TONE). */
const TONES = `
  .wsui .t-ok { --fg: var(--sd-ok); --bg: var(--sd-ok-bg); --bd: var(--sd-ok-bd); }
  .wsui .t-warn { --fg: var(--sd-warn); --bg: var(--sd-warn-bg); --bd: var(--sd-warn-bd); }
  .wsui .t-err { --fg: var(--sd-err); --bg: var(--sd-err-bg); --bd: var(--sd-err-bd); }
  .wsui .t-off { --fg: var(--sd-off); --bg: var(--sd-off-bg); --bd: var(--sd-off-bd); }
  .wsui .t-pr { --fg: var(--sd-pr); --bg: var(--sd-pr-bg); --bd: var(--sd-pr-bd); }
  .wsui .t-needs { --fg: var(--sd-on-warn-solid); --bg: var(--sd-warn-solid); --bd: var(--sd-warn-solid); }
`;

export const CARD_CSS = `${TONES}
  .wsui .ws-card {
    position: relative; background: var(--sd-card); border: 1px solid var(--sd-line);
    border-radius: 10px; box-shadow: var(--sd-shadow-card); font: 14px/1.45 var(--sd-sans);
    color: var(--sd-ink); font-variant-numeric: tabular-nums; text-align: left;
  }
  .wsui .ws-card.attn { border-color: var(--sd-attn-bd); box-shadow: var(--sd-shadow-card-attn); }
  .wsui .muted { color: var(--sd-muted); }
  .wsui .faint { color: var(--sd-faint); }
  .wsui .small { font-size: 13px; }
  .wsui .spacer { flex: 1; }
  .wsui .link {
    all: unset; cursor: pointer; color: var(--sd-info);
  }
  .wsui .link:hover, .wsui .link:focus-visible { text-decoration: underline; }

  .wsui .ws-head {
    display: flex; flex-direction: column; gap: 7px; padding: 16px 18px 14px;
    border-bottom: 1px solid var(--sd-line-soft); border-radius: 9px 9px 0 0;
  }
  .wsui .ws-card.attn .ws-head { background: var(--sd-attn-bg); border-bottom-color: var(--sd-attn-bd); }
  .wsui .ws-row1 { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; }
  .wsui .ws-name {
    flex: 1 1 220px; min-width: 0; font-weight: 600; font-size: 15.5px;
    letter-spacing: -0.01em; line-height: 1.3; overflow-wrap: anywhere;
  }
  .wsui .ws-chips { display: inline-flex; gap: 6px; margin-left: auto; flex: none; }
  .wsui .chip {
    display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 4px;
    font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--fg); background: var(--bg);
  }
  .wsui .auto {
    display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 4px;
    font-size: 12px; font-weight: 600; white-space: nowrap; border: 1px solid var(--sd-ctl);
  }
  .wsui .ws-row2 { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 13.5px; }
  .wsui .type-tag {
    font: 600 10.5px/1 var(--sd-mono); letter-spacing: .08em; text-transform: uppercase;
    padding: 4px 6px 3px; border-radius: 3px; background: var(--sd-off-bg); color: var(--sd-muted);
  }
  .wsui .ws-title { text-wrap: pretty; overflow-wrap: anywhere; }
  .wsui .ws-row3 { display: flex; align-items: center; gap: 8px; font: 400 12px var(--sd-mono); }

  .wsui .attn .question {
    all: unset; box-sizing: border-box; display: flex; gap: 10px; align-items: baseline;
    margin-top: 4px; width: 100%; padding: 8px 12px; border-radius: 6px; cursor: pointer;
    background: var(--sd-card); border: 1px solid var(--sd-attn-bd); font-size: 13px;
  }
  .wsui .attn .question.open { display: block; cursor: default; padding: 12px 14px 14px; }
  .wsui .q-label { color: var(--sd-warn); font-weight: 600; white-space: nowrap; }
  .wsui .q-clip { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wsui .question .muted { white-space: nowrap; }
  .wsui .q-meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
  .wsui .q-toggle { all: unset; cursor: pointer; color: var(--sd-muted); }
  .wsui .q-text { margin: 6px 0 12px; font-size: 15px; line-height: 1.5; text-wrap: pretty; overflow-wrap: anywhere; }

  .wsui .ws-rows { display: grid; grid-template-columns: 92px minmax(0, 1fr); }
  .wsui .ws-rows > .lbl {
    padding: 12px 0 12px 18px; font: 600 10.5px/20px var(--sd-mono); letter-spacing: .08em;
    text-transform: uppercase; color: var(--sd-muted);
  }
  .wsui .ws-rows > .val {
    padding: 12px 18px 12px 12px; display: flex; flex-wrap: wrap; align-items: center;
    gap: 4px 14px; min-width: 0;
  }
  .wsui .ws-rows > :nth-child(n+3) { border-top: 1px solid var(--sd-line-soft); }
  .wsui .ws-rows > .val.col { flex-direction: column; align-items: stretch; flex-wrap: nowrap; gap: 6px; }
  .wsui .dot {
    flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fg);
    box-shadow: 0 0 0 3px var(--bg);
  }
  .wsui .sum { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; white-space: nowrap; }
  .wsui .svc { font-size: 13px; white-space: nowrap; color: var(--sd-muted); }
  .wsui .svc .g, .wsui .svc.hot { color: var(--fg); }
  .wsui .pr { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .wsui .pr-ref { font: 500 12.5px var(--sd-mono); }
  .wsui .badge {
    display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 3px;
    font-size: 12px; font-weight: 600; white-space: nowrap;
    color: var(--fg); background: var(--bg); border: 1px solid var(--bd);
  }
  .wsui .badge.dashed { border-style: dashed; }
  .wsui .ci {
    display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500;
    white-space: nowrap; color: var(--fg);
  }
  .wsui .ci-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg); }
  .wsui .unavailable { color: var(--sd-warn); line-height: 20px; }
  .wsui .val.col > .muted { line-height: 20px; }
  .wsui .wf { font-weight: 500; }
  .wsui .wf.strong { font-weight: 600; }
  .wsui .pips { display: inline-flex; gap: 3px; margin-left: auto; }
  .wsui .pip { width: 20px; height: 6px; border-radius: 2px; background: var(--sd-line); }
  .wsui .pip.done { background: var(--sd-ink); }
  .wsui .pip.current { background: var(--sd-muted); }
  .wsui .agent { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; white-space: nowrap; }
  .wsui .agent.needs { color: var(--sd-warn); }

  .wsui .bar {
    position: relative; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
    padding: 12px 18px; border-top: 1px solid var(--sd-line-soft);
  }
  .wsui .btn {
    font-size: 13px; font-weight: 500; height: 30px; padding: 0 11px; border-radius: 6px;
    border: 1px solid var(--sd-ctl); background: var(--sd-card); color: var(--sd-ink);
    box-shadow: var(--sd-shadow-btn); cursor: pointer; white-space: nowrap;
  }
  .wsui .btn:hover:not(:disabled) { background: var(--sd-hover); }
  .wsui .btn:disabled { opacity: .5; cursor: default; }
  .wsui .btn:focus-visible, .wsui .item:focus-visible, .wsui .question:focus-visible {
    outline: 2px solid var(--sd-accent); outline-offset: 2px;
  }
  .wsui .btn.primary {
    font-weight: 600; padding: 0 12px; background: var(--sd-accent); border-color: var(--sd-accent);
    color: var(--sd-on-accent); box-shadow: var(--sd-shadow-btn-primary);
  }
  .wsui .btn.primary:hover:not(:disabled) { background: var(--sd-accent-hover); }
  .wsui .btn.destructive, .wsui .btn.primary.destructive {
    font-weight: 600; padding: 0 12px; background: var(--sd-err-bg); border-color: var(--sd-err);
    color: var(--sd-err); box-shadow: none;
  }
  .wsui .btn.more { width: 30px; padding: 0; font-size: 15px; font-weight: 600; }
  .wsui .btn.more.open { background: var(--sd-hover); border-color: var(--sd-ink); }
  .wsui .act-msg { font-size: 12px; color: var(--sd-muted); }
  .wsui .act-msg.err { color: var(--sd-err); }
  .wsui .menu {
    position: absolute; right: 18px; top: calc(100% - 8px); z-index: 5; min-width: 220px;
    padding: 5px; border-radius: 8px; background: var(--sd-card); border: 1px solid var(--sd-line);
    box-shadow: var(--sd-shadow-menu); font-size: 13px; display: flex; flex-direction: column;
  }
  .wsui .item {
    all: unset; padding: 7px 10px; border-radius: 5px; color: var(--sd-ink); cursor: pointer;
  }
  .wsui .item:hover:not(:disabled) { background: var(--sd-hover); }
  .wsui .item:disabled { opacity: .45; cursor: default; }
  .wsui .item.sep { border-bottom: 1px solid var(--sd-line-soft); border-radius: 5px 5px 0 0; }
  .wsui .menu .divider { height: 1px; margin: 4px 6px; background: var(--sd-line); }
  .wsui .item.abandon { color: var(--sd-err); font-weight: 600; }
  .wsui .item.abandon:hover { background: var(--sd-err-bg); }

  .wsui .confirm {
    display: flex; flex-direction: column; gap: 12px; padding: 14px 18px 16px;
    border-top: 1px solid var(--sd-err-bd); border-radius: 0 0 9px 9px;
  }
  .wsui .confirm.abandon { background: var(--sd-err-bg); border-top-color: var(--sd-err); }
  .wsui .confirm-title { font-weight: 600; overflow-wrap: anywhere; }
  .wsui .confirm.abandon .confirm-title { color: var(--sd-err); }
  .wsui .confirm-line { font-size: 13px; color: var(--sd-muted); }
  .wsui .confirm.abandon .confirm-line { color: var(--sd-ink); }
  .wsui .confirm-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .wsui .reason { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--sd-muted); }
  .wsui .reason input {
    font: inherit; font-size: 13px; height: 32px; box-sizing: border-box; padding: 0 10px;
    border-radius: 6px; border: 1px solid var(--sd-ctl); background: var(--sd-card); color: var(--sd-ink);
  }
  .wsui .btn.abandon-yes {
    font-weight: 600; padding: 0 12px; background: var(--sd-err); border-color: var(--sd-err);
    color: var(--sd-card); box-shadow: none;
  }
  .wsui .btn.abandon-yes:hover:not(:disabled) { background: var(--sd-err); }

  .wsui .ws-panel { border-top: 1px solid var(--sd-line-soft); }
  .wsui .ws-panel:empty { display: none; }
  .wsui .panel-usage { padding: 8px 18px; font-size: 12px; }
  .wsui .panel-logs pre {
    margin: 0; padding: 10px 18px; max-height: 320px; overflow: auto; white-space: pre-wrap;
    overflow-wrap: anywhere; font: 12px/1.5 var(--sd-mono); color: var(--sd-ink); background: var(--sd-bg);
    border-radius: 0 0 9px 9px;
  }

  .wsui .sk { display: inline-block; height: 12px; border-radius: 3px; background: var(--sd-line-soft); }
  .wsui .sk-chip { width: 92px; height: 22px; border-radius: 4px; }
  .wsui .sk-tag { width: 58px; height: 16px; }
  .wsui .sk-title { width: 52%; }
  .wsui .w30 { width: 30px; } .wsui .w72 { width: 72px; } .wsui .w84 { width: 84px; }
  .wsui .w110 { width: 110px; } .wsui .w140 { width: 140px; } .wsui .w160 { width: 160px; }
  .wsui .w180 { width: 180px; }
  .wsui .sk.h30 { height: 30px; border-radius: 6px; }
  .wsui .loading { font-size: 12px; color: var(--sd-faint); }
`;

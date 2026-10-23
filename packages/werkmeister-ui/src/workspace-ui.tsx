/**
 * Shared Sandbox Workspaces UI — the single source for all three surfaces:
 *
 *   • Browser dashboard     (apps/werkmeister-dashboard/src/browser-main.ts → browser.html)
 *   • Cowork live artifact  (apps/werkmeister-dashboard/src/artifact-main.ts → workspace-list.artifact.html)
 *   • MCP App inline view   (apps/werkmeister-mcp/ui/mcp-list.ts → mcp-list.html)
 *
 * The UI is host-agnostic: every server call and external link goes through
 * the {@link HostBridge} the entrypoint supplies. It renders the top bar, the
 * filter (text + Needs you) and one always-expanded {@link WorkspaceCard} per
 * workspace (SW-53). React is bundled inline by each surface's viteSingleFile
 * build, so the Cowork artifact's strict CSP still holds. Cards open the chat
 * panel, usage and logs on demand.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Lifecycle, RepoPr, WorkspaceStatus } from "werkmeister-core";
import { ChatPanel, type ClaudeMessage } from "./chat-panel.js";
import { type DisplayInput, displayModel, type Tone } from "./display-model.js";
import { filterWorkspaces } from "./lib/workspace-search.js";
import { Css } from "./theme.js";
import { Usage, type WorkspaceUsage } from "./usage-widget.js";
import {
  CARD_CSS,
  type CardAction,
  type PanelKind,
  toolCall,
  WorkspaceCard,
} from "./workspace-card.js";

export interface HostBridge {
  /**
   * Call a Sandbox server tool by its short name (e.g. "list-workspaces") and
   * resolve its structured content. Must throw on tool errors and when the
   * host connection isn't available.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Open an external URL (issue, PR) in the user's browser. */
  openLink(url: string): void;
  /**
   * Optional live session stream. Present ONLY on the browser surface (a
   * same-origin Express server that can hold an SSE socket); when absent,
   * the chat panel falls back to claude-transcript/claude-turn-status polling. This
   * optional method IS the fallback switch — the Desktop-inline and Cowork
   * artifact surfaces leave it undefined and keep polling.
   *
   * Delivers backfill (`onEntry` per index, then `onReady`) followed by live
   * `onEntry`/`onTurn` deltas. Entries are index-addressed upserts. Returns an
   * unsubscribe.
   */
  streamSession?(
    name: string,
    handlers: {
      onEntry(index: number, message: ClaudeMessage): void;
      onTurn(state: "running" | "done" | "failed", error?: string | null): void;
      onReady(meta?: {
        sessionId: string | null;
        sessionCount: number;
        updatedAt: string | null;
      }): void;
    },
    /** Resume backfill from this entry index (skips what a reconnect already has). */
    fromIndex?: number,
    /** Pin the stream to a specific session id; absent → follow the newest. */
    sessionId?: string,
  ): () => void;
}

/** One `list-workspaces` row. */
interface WorkspaceEntry {
  name: string;
  path: string;
  vscodeUri: string;
  issueId: string | null;
  issueUrl: string | null;
  labels: string[];
  task?: string | null;
  workType?: string | null;
  lifecycle?: Lifecycle;
}

interface Counted {
  state?: string;
  running?: number;
  total?: number;
  healthy?: number;
}

const CSS = `
  .wsui, .wsui * { box-sizing: border-box; }
  .wsui {
    color-scheme: light dark; font: 14px/1.45 var(--sd-sans);
    background: var(--sd-bg); color: var(--sd-ink); padding: 20px;
  }
  .wsui button { font: inherit; }
  .wsui .topbar {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 12px 16px;
    background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 10px;
  }
  .wsui .brand { font-weight: 600; font-size: 15px; }
  .wsui .root-path { font: 400 12px var(--sd-mono); color: var(--sd-muted); overflow-wrap: anywhere; }
  .wsui .tb-items { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; font-size: 13px; margin-left: auto; }
  .wsui .tb-item { display: inline-flex; align-items: center; gap: 6px; }
  .wsui .tb-item .g { color: var(--fg); }
  .wsui .tb-item b { color: var(--fg); font-weight: 600; }
  .wsui .tb-k8s { all: unset; cursor: pointer; display: inline-flex; gap: 6px; }
  .wsui .tb-k8s:hover, .wsui .tb-k8s:focus-visible { text-decoration: underline; }
  .wsui .kube-ctx {
    font: 400 11px var(--sd-mono); color: var(--sd-muted); max-width: 260px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wsui .btn.tb-btn { height: 28px; padding: 0 10px; }
  .wsui .tb-msg { font-size: 12px; color: var(--sd-muted); }
  .wsui .tb-msg.err { color: var(--sd-err); }

  .wsui .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 16px 0 12px; }
  .wsui input[type="search"] {
    flex: 1 1 320px; height: 34px; padding: 0 10px; border: 1px solid var(--sd-ctl);
    border-radius: 5px; font: inherit; background: var(--sd-card); color: var(--sd-ink);
  }
  .wsui .seg {
    display: inline-flex; margin: 0; padding: 0; min-width: 0; border: 1px solid var(--sd-ctl);
    border-radius: 5px; overflow: hidden; font-size: 13px;
  }
  .wsui .seg button {
    all: unset; padding: 6px 12px; cursor: pointer; font-weight: 600;
    background: var(--sd-card); color: var(--sd-ink);
  }
  .wsui .seg button + button { border-left: 1px solid var(--sd-ctl); }
  .wsui .seg button.all.on { background: var(--sd-ink); color: var(--sd-card); }
  .wsui .seg button.needs { color: var(--sd-warn); }
  .wsui .seg button.needs.on { background: var(--sd-warn-solid); color: var(--sd-on-warn-solid); }
  .wsui .seg button:focus-visible { outline: 2px solid var(--sd-accent); outline-offset: -2px; }
  .wsui .count { font-size: 13px; color: var(--sd-muted); white-space: nowrap; }
  .wsui .focus-only { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }

  .wsui .cards {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(min(440px, 100%), 1fr));
    gap: 12px; align-items: start;
  }
  .wsui .load-status { padding: 24px; text-align: center; color: var(--sd-muted); }
  .wsui .load-status.err { color: var(--sd-err); }
  .wsui .load-status .hint { font-size: 12px; color: var(--sd-faint); margin: 6px 0 10px; }
  .wsui .empty { color: var(--sd-muted); padding: 12px 0; }

  .wsui .legend {
    margin-top: 20px; padding: 14px 0 4px; border-top: 1px solid var(--sd-line);
    display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: var(--sd-muted); align-items: center;
  }
  .wsui .legend-title { font: 600 11px var(--sd-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--sd-ink); }
  .wsui .legend b { color: var(--fg, var(--sd-ink)); }
  .wsui .legend-attn {
    display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px;
    border: 2px solid var(--sd-attn-bd); background: var(--sd-attn-bg);
  }
  /* .kube-env pills come from the theme; the chat panel styles itself
     (chat-panel.ts, .claude-chat scope); .usage-* rows come from usage-widget.ts. */
`;

/** Infra / k8s summary → the dot scale: all up ok · some warn · none err · unknown off. */
function countTone(up: number, total: number, state?: string): Tone {
  if (state === "unknown" || !total) return "off";
  if (up === total) return "ok";
  return up === 0 ? "err" : "warn";
}

const GLYPH: Record<Tone, string> = { ok: "●", warn: "◐", err: "▲", off: "○", pr: "●", needs: "●" };

function TopItem({ label, up, total, state }: { label: string } & Counted & { up: number }) {
  const tone = countTone(up, total ?? 0, state);
  return (
    <>
      <span className={`g t-${tone}`}>{GLYPH[tone]}</span> {label}{" "}
      <b className={`t-${tone}`}>{total ? `${up} of ${total} up` : (state ?? "…")}</b>
    </>
  );
}

function TopBar({
  bridge,
  root,
  infra,
  onConnected,
  onRefresh,
  onNewWorkspace,
}: {
  bridge: HostBridge;
  root: string;
  infra: Counted | null;
  onConnected(): void;
  onRefresh(): void;
  onNewWorkspace?: () => void;
}) {
  const [k8s, setK8s] = useState<(Counted & { title: string }) | null>(null);
  const [kube, setKube] = useState<{ env: string; context: string | null } | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refreshK8s = useCallback(async () => {
    setK8s(null);
    try {
      const d = await bridge.callTool("k8s-forwards-status", {});
      const bad = (d.forwards ?? []).filter((f: { healthy: boolean }) => !f.healthy);
      setK8s({
        healthy: d.healthy,
        total: d.total,
        title: bad.length
          ? `Unhealthy: ${bad.map((f: { name: string; port: number; detail: string }) => `${f.name} :${f.port} (${f.detail})`).join(", ")} — click to re-check`
          : "All default k8s port-forwards healthy — click to re-check",
      });
    } catch {
      setK8s({ state: "unknown", title: "Couldn’t check k8s forwards — click to retry" });
    }
  }, [bridge]);

  useEffect(() => {
    void refreshK8s();
    bridge.callTool("kube-context", {}).then(
      (k) => setKube({ env: k.env ?? "other", context: k.context ?? null }),
      () => setKube({ env: "other", context: null }),
    );
  }, [bridge, refreshK8s]);

  const connect = async () => {
    setConnecting(true);
    setMsg({ text: "Running sandbox connect…" });
    try {
      await bridge.callTool("connect", {});
      setMsg({ text: "Infrastructure connected." });
      onConnected();
      void refreshK8s();
    } catch {
      setMsg({ text: "Connect failed — see server logs.", err: true });
    }
    setConnecting(false);
  };
  const switchKube = async () => {
    setMsg({ text: "Switching kube context…" });
    try {
      const k = await bridge.callTool("kube-switch", { env: "dev" });
      setKube({ env: k.env ?? "dev", context: k.context ?? null });
      setMsg({ text: "Switched to dev." });
    } catch {
      setMsg({ text: "Kube switch failed.", err: true });
    }
  };

  const env = kube && ["dev", "stage", "prod"].includes(kube.env) ? kube.env : "other";
  const infraUp = infra?.state === "up";
  return (
    <header className="topbar">
      <span className="brand">Werkmeister Dashboard</span>
      <span className="root-path">{root}</span>
      <span className="tb-items">
        <span className="tb-item">
          <TopItem
            label="Infra"
            up={infra?.running ?? 0}
            total={infra?.total}
            state={infra?.state}
          />
        </span>
        <button
          type="button"
          className="tb-k8s tb-item"
          title={k8s?.title ?? "Checking k8s forwards…"}
          onClick={() => void refreshK8s()}
        >
          <TopItem
            label="k8s forwards"
            up={k8s?.healthy ?? 0}
            total={k8s?.total}
            state={k8s?.state}
          />
        </button>
        <span className="tb-item">
          Kube{" "}
          <span className={`kube-env ${env}`}>
            {kube ? (env === "other" ? "unknown" : env) : "…"}
          </span>
          {kube?.context && (
            <span className="kube-ctx" title={kube.context}>
              {kube.context}
            </span>
          )}
          {kube && kube.env !== "dev" && (
            <button type="button" className="btn tb-btn" onClick={() => void switchKube()}>
              Switch to dev
            </button>
          )}
        </span>
        {onNewWorkspace && (
          <button type="button" className="btn tb-btn" onClick={onNewWorkspace}>
            ＋ New workspace
          </button>
        )}
        <button
          type="button"
          className="btn tb-btn"
          disabled={infraUp || connecting}
          title={
            infraUp
              ? "Shared infrastructure is up and healthy — nothing to connect."
              : "Start shared infrastructure (sandbox connect)"
          }
          onClick={() => void connect()}
        >
          ⚡ Connect infra
        </button>
        <button
          type="button"
          className="btn tb-btn"
          title="Reload every workspace"
          onClick={onRefresh}
        >
          ↻ Refresh
        </button>
        {msg && <span className={msg.err ? "tb-msg err" : "tb-msg"}>{msg.text}</span>}
      </span>
    </header>
  );
}

function Legend() {
  return (
    <footer className="legend">
      <span className="legend-title">Legend</span>
      <span>
        <span className="legend-attn" /> amber border = <b>● Needs you</b>, nothing else
      </span>
      <span>
        <b className="t-ok">green</b> ok · <b className="t-warn">amber</b> partial / attention ·{" "}
        <b className="t-err">red</b> failing · <b className="t-off">grey</b> off
      </span>
      <span>◌ Working · ✓ Done · Idle</span>
      <span>● up · ○ down · ◐ starting · ▲ unhealthy</span>
      <span>
        <b className="t-pr">Merged / Released</b> PR shipped
      </span>
      <span>⚙ Autonomous = no review gates until the PR</span>
    </footer>
  );
}

/** The list, its filter and the top bar (portalled into `headerRoot` when given). */
export function WorkspaceList({
  bridge,
  headerRoot,
  renderMarkdown,
  reloadRef,
  onNewWorkspace,
}: {
  bridge: HostBridge;
  headerRoot: HTMLElement | null;
  renderMarkdown?: (src: string) => string;
  reloadRef: { current: () => void };
  onNewWorkspace?: () => void;
}) {
  const [all, setAll] = useState<WorkspaceEntry[] | null>(null);
  const [root, setRoot] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus> | null>(null);
  const [infra, setInfra] = useState<Counted | null>(null);
  // undefined while loading; null when the lookup failed (→ "PRs unavailable · retry").
  const [prs, setPrs] = useState<Record<string, RepoPr[]> | null | undefined>(undefined);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [needsOnly, setNeedsOnly] = useState(false);
  const [focusOnly, setFocusOnly] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const d = await bridge.callTool("status", {});
      setStatuses(Object.fromEntries((d.statuses ?? []).map((s: WorkspaceStatus) => [s.name, s])));
      setInfra(d.infra ?? null);
    } catch {
      // Keep what we have; with nothing yet, every card reads Docker unreachable.
      setStatuses((s) => s ?? {});
    }
  }, [bridge]);

  const refreshPrs = useCallback(async () => {
    setPrs(undefined);
    try {
      const d = await bridge.callTool("workspace-prs", {});
      setPrs(
        Object.fromEntries(
          (d.workspaces ?? []).map((w: { name: string; repos?: RepoPr[] }) => [
            w.name,
            w.repos ?? [],
          ]),
        ),
      );
    } catch {
      setPrs(null);
    }
  }, [bridge]);

  const load = useCallback(
    async (attempt = 0): Promise<void> => {
      setLoadError(null);
      try {
        const d = await bridge.callTool("list-workspaces", {});
        setAll(d.workspaces ?? []);
        setRoot(d.root ?? "");
        setRetrying(0);
        await Promise.all([refreshStatus(), refreshPrs()]);
      } catch (e) {
        // The host bridge may still be wiring up on a cold open — retry a few
        // times before surfacing a manual Retry button.
        if (attempt < 3) {
          setRetrying(attempt + 1);
          setTimeout(() => void load(attempt + 1), 3000);
          return;
        }
        setRetrying(0);
        setLoadError((e as Error).message);
      }
    },
    [bridge, refreshStatus, refreshPrs],
  );

  useEffect(() => {
    reloadRef.current = () => void load();
    void load();
  }, [load, reloadRef]);

  const onAction = async (w: WorkspaceEntry, action: CardAction, reason?: string) => {
    if (action === "retry-status") return void refreshStatus();
    if (action === "refresh-prs") return void refreshPrs();
    const a = toolCall(action, w.name, reason);
    if (!a) return;
    setBusy((b) => ({ ...b, [w.name]: `${a.verb}…` }));
    setErrors(({ [w.name]: _, ...rest }) => rest);
    try {
      await bridge.callTool(a.tool, a.args);
      // close-out changes the set of workspaces, not just a state.
      if (a.tool === "close-out") setAll((list) => list?.filter((x) => x.name !== w.name) ?? null);
      await refreshStatus();
    } catch (e) {
      setErrors((x) => ({ ...x, [w.name]: `${a.verb} failed: ${(e as Error).message}` }));
    }
    setBusy(({ [w.name]: _, ...rest }) => rest);
  };

  const renderPanel = (name: string, kind: PanelKind) =>
    kind === "chat" ? (
      <ChatPanel
        name={name}
        bridge={bridge}
        placeholder="Message this workspace’s Claude session…"
        renderMarkdown={renderMarkdown}
        // Done or a question is the Stop hook's call, so read it back rather than guess.
        onActivity={({ running }) => {
          if (!running) void refreshStatus();
        }}
      />
    ) : (
      <ToolPanel kind={kind} name={name} bridge={bridge} />
    );

  const shown = useMemo(() => {
    if (!all) return [];
    const needs = (w: WorkspaceEntry) => statuses?.[w.name]?.claude.agent === "needs-you";
    const base = all.filter(
      (w) => (!needsOnly || needs(w)) && (!focusOnly || w.labels.includes("focus")),
    );
    return query.trim()
      ? filterWorkspaces(base, query.trim(), {
          cstateByWs: statuses ?? {},
          prsByWs: prs ?? {},
        })
      : base;
  }, [all, statuses, prs, needsOnly, focusOnly, query]);
  const needCount =
    all?.filter((w) => statuses?.[w.name]?.claude.agent === "needs-you").length ?? 0;

  const header = (
    <TopBar
      bridge={bridge}
      root={root}
      infra={infra}
      onConnected={() => void refreshStatus()}
      onRefresh={() => void load()}
      onNewWorkspace={onNewWorkspace}
    />
  );

  let body: ReactNode;
  if (loadError)
    body = (
      <div className="load-status err">
        <div>Couldn’t reach the host: {loadError}</div>
        <div className="hint">
          The connection may still be starting up. Wait a moment, then retry.
        </div>
        <button type="button" className="btn primary" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  else if (!all)
    body = (
      <div className="load-status">
        {retrying ? `Connection not ready — retrying (${retrying}/3)…` : "Loading workspaces…"}
      </div>
    );
  else
    body = (
      <>
        <div className="controls">
          <input
            type="search"
            aria-label="Filter workspaces"
            placeholder="Filter by name, issue, state, repo, label…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <fieldset className="seg" aria-label="Show">
            <button
              type="button"
              className={needsOnly ? "all" : "all on"}
              aria-pressed={!needsOnly}
              onClick={() => setNeedsOnly(false)}
            >
              All · {all.length}
            </button>
            <button
              type="button"
              className={needsOnly ? "needs on" : "needs"}
              aria-pressed={needsOnly}
              onClick={() => setNeedsOnly(true)}
            >
              ● Needs you · {needCount}
            </button>
          </fieldset>
          <label className="focus-only">
            <input
              type="checkbox"
              checked={focusOnly}
              onChange={(e) => setFocusOnly(e.target.checked)}
            />
            Focused only
          </label>
          <span className="count">
            {shown.length} of {all.length}
          </span>
        </div>
        <div className="cards">
          {shown.map((w) => {
            const s = statuses?.[w.name];
            return (
              <WorkspaceCard
                key={w.name}
                name={w.name}
                path={w.path}
                task={w.task ?? null}
                workType={w.workType ?? null}
                issueId={w.issueId}
                issueUrl={w.issueUrl}
                display={
                  statuses
                    ? displayModel(s ?? UNREACHABLE, {
                        prs: prs === null ? null : (prs?.[w.name] ?? []),
                        lifecycle: w.lifecycle ?? null,
                      })
                    : null
                }
                state={statuses ? (s?.state ?? "unknown") : null}
                prsLoading={prs === undefined}
                busy={busy[w.name] ?? null}
                error={errors[w.name] ?? null}
                onAction={(a, r) => void onAction(w, a, r)}
                onOpenLink={(url) => bridge.openLink(url)}
                renderPanel={(kind) => renderPanel(w.name, kind)}
              />
            );
          })}
        </div>
        {!shown.length && (
          <div className="empty">
            {needsOnly ? "No workspace needs you." : "No workspace matches."}
          </div>
        )}
        <Legend />
      </>
    );

  return (
    <>
      <Css id="wsui" css={CSS + CARD_CSS} />
      {headerRoot ? createPortal(header, headerRoot) : header}
      {body}
    </>
  );
}

/** Usage or the last 200 log lines, fetched once per opening. */
function ToolPanel({
  kind,
  name,
  bridge,
}: {
  kind: "usage" | "logs";
  name: string;
  bridge: HostBridge;
}) {
  const [result, setResult] = useState<{ data: any } | { error: string } | null>(null);
  useEffect(() => {
    const args = kind === "logs" ? { workspace: name, tail: 200 } : { workspace: name };
    bridge.callTool(kind === "usage" ? "workspace-usage" : "logs", args).then(
      (data) => setResult({ data }),
      (e) => setResult({ error: (e as Error).message }),
    );
  }, [bridge, kind, name]);
  if (!result) return kind === "usage" ? "Computing usage…" : "Reading logs…";
  if ("error" in result)
    return `${kind === "usage" ? "Failed to load usage" : "Failed to read logs"}: ${result.error}`;
  if (kind === "usage") return <Usage usage={result.data as WorkspaceUsage} />;
  return <pre>{result.data?.output?.trim() || "No log lines."}</pre>;
}

/** A workspace `status` didn't report: no containers known, no live agent. */
const UNREACHABLE: DisplayInput = {
  state: "unknown",
  running: 0,
  total: 0,
  services: [],
  claude: { agent: "idle", at: null, question: null },
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
};

export function initWorkspaceUI(
  bridge: HostBridge,
  root: HTMLElement,
  opts?: {
    headerRoot?: HTMLElement;
    renderMarkdown?: (src: string) => string;
    /** Shows `＋ New workspace` in the top bar; the surface decides where the create form opens. */
    onNewWorkspace?: () => void;
  },
): { reload: () => void } {
  root.classList.add("wsui");
  opts?.headerRoot?.classList.add("wsui");
  const reloadRef = { current: () => {} };
  createRoot(root).render(
    <WorkspaceList
      bridge={bridge}
      headerRoot={opts?.headerRoot ?? null}
      renderMarkdown={opts?.renderMarkdown}
      reloadRef={reloadRef}
      onNewWorkspace={opts?.onNewWorkspace}
    />,
  );
  // Let the dashboard shell refresh the list after a workspace is created.
  return { reload: () => reloadRef.current() };
}

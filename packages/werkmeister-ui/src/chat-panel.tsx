/**
 * Embedded Claude Code chat panel — the single component behind both the
 * Workspaces tab (per-workspace session) and the Open-Pull-Requests tab (a
 * `reconcile:<repo>-<number>` session), so the two surfaces share ONE chat UI.
 *
 * Keyed by an opaque `name` (a workspace name OR a `reconcile:` session key);
 * the server resolves it to a directory (werkmeister-core `resolveSessionDir`).
 * The browser surface live-streams over SSE (`bridge.streamSession`); hosts
 * that leave it undefined (Desktop-inline) fall back to
 * `claude-transcript` / `claude-turn-status` polling.
 *
 * It styles itself (`.claude-chat` scope, full button styles) so it renders the
 * same on every page. The one link back to a host list is the optional
 * `onActivity` hook (drives the Workspaces list's status refresh); the PR page
 * omits it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OptionsInput, type OptionsInputOpts } from "./options-input.js";
import { Css } from "./style.js";

export interface ClaudeMessage {
  role: string;
  text: string;
}

/** The slice of the host bridge the chat panel needs. */
export interface ChatBridge {
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
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
    fromIndex?: number,
    sessionId?: string,
  ): () => void;
}

export interface ChatPanelProps {
  /** A workspace name or a `reconcile:` session key. */
  name: string;
  bridge: ChatBridge;
  /** Textarea placeholder. */
  placeholder?: string;
  /**
   * Optional decision widget shown once the session's turn settles and Claude
   * has replied (e.g. the reconcile flow's Approve / Request changes). Generic +
   * reusable — the host supplies the options and their actions.
   */
  decisionOptions?: OptionsInputOpts;
  /**
   * Optional markdown→HTML renderer (must be XSS-safe, i.e. html:false) for
   * assistant replies. Injected rather than imported so the markdown-it dep
   * stays out of the strict-CSP artifact / inline bundles — surfaces that omit
   * it show plain text. Only the browser surfaces pass it.
   */
  renderMarkdown?: (src: string) => string;
  /**
   * Fired (streaming surface only) when the "waiting for input" state flips —
   * waiting = no turn running AND Claude spoke last. Hosts use it to drive a
   * list-level badge; omit it when there's no such list.
   */
  onActivity?: (s: { waiting: boolean; running: boolean }) => void;
  /** false while the host hides the panel (a collapsed PR card): no socket, slow polling. */
  visible?: boolean;
}

export interface ChatState {
  messages: ClaudeMessage[];
  loaded: boolean;
  sessionId: string | null;
  sessionCount: number;
  updatedAt: string | null;
  error: string | null;
  sending: boolean;
}

const CHAT_CSS = `
  .claude-chat { border-top: 1px solid var(--sd-chat-line); background: var(--sd-chat-bg); }
  .claude-chat, .claude-chat * { box-sizing: border-box; }
  .claude-chat .chat-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 11px; color: var(--sd-chat-muted); }
  .claude-chat .btn {
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    padding: 3px 8px; border-radius: 6px; border: 1px solid var(--sd-chat-ctl); background: var(--sd-chat-surface); color: var(--sd-chat-btn-ink);
  }
  .claude-chat .btn:hover { background: var(--sd-chat-line); }
  .claude-chat .btn:disabled { opacity: 0.5; cursor: default; }
  .claude-chat .btn.primary { background: var(--sd-accent); border-color: var(--sd-accent); color: var(--sd-on-accent); }
  .claude-chat .btn.primary:hover { background: var(--sd-accent-hover); }
  .claude-chat .chat-title { font-weight: 700; color: var(--sd-chat-title); text-transform: uppercase; letter-spacing: 0.05em; }
  .claude-chat .chat-picker {
    flex: 1; min-width: 0; max-width: 320px; font: inherit; font-size: 11px;
    padding: 3px 6px; background: var(--sd-chat-surface); color: var(--sd-chat-btn-ink);
    border: 1px solid var(--sd-chat-ctl); border-radius: 6px;
  }
  .claude-chat .chat-msgs { max-height: 320px; overflow-y: auto; padding: 4px 14px 8px; display: flex; flex-direction: column; gap: 8px; scrollbar-color: var(--sd-chat-ctl) var(--sd-chat-bg); }
  .claude-chat .chat-msgs::-webkit-scrollbar { width: 8px; }
  .claude-chat .chat-msgs::-webkit-scrollbar-thumb { background: var(--sd-chat-ctl); border-radius: 4px; }
  .claude-chat .chat-msgs::-webkit-scrollbar-track { background: var(--sd-chat-bg); }
  .claude-chat .msg { max-width: 82%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .claude-chat .msg-user { align-self: flex-end; background: var(--sd-accent); color: var(--sd-on-accent); border-bottom-right-radius: 4px; }
  .claude-chat .msg-assistant { align-self: flex-start; background: var(--sd-chat-surface); border: 1px solid var(--sd-chat-line-soft); color: var(--sd-chat-ink); border-bottom-left-radius: 4px; }
  .claude-chat .msg-tool {
    align-self: flex-start; max-width: 95%; padding: 1px 4px;
    font-family: var(--sd-mono); font-size: 11px;
    color: var(--sd-chat-muted); background: transparent; border-radius: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .claude-chat .msg-info { align-self: center; font-size: 11px; color: var(--sd-chat-faint); padding: 2px 0; }
  .claude-chat .msg-err { align-self: center; font-size: 12px; color: var(--sd-chat-err); padding: 2px 0; }
  /* Rendered-markdown assistant bubbles (opts.renderMarkdown). These rules come
     after .msg so .md's white-space:normal wins over .msg's pre-wrap. */
  .claude-chat .md { white-space: normal; }
  .claude-chat .md > :first-child { margin-top: 0; }
  .claude-chat .md > :last-child { margin-bottom: 0; }
  .claude-chat .md h1, .claude-chat .md h2, .claude-chat .md h3, .claude-chat .md h4 {
    margin: 10px 0 6px; font-size: 13px; font-weight: 700; color: var(--sd-chat-heading); line-height: 1.3;
  }
  .claude-chat .md p { margin: 6px 0; }
  .claude-chat .md ul, .claude-chat .md ol { margin: 6px 0; padding-left: 20px; }
  .claude-chat .md li { margin: 2px 0; }
  .claude-chat .md strong { color: var(--sd-chat-strong); font-weight: 700; }
  .claude-chat .md a { color: var(--sd-chat-link); }
  .claude-chat .md code {
    font-family: var(--sd-mono); font-size: 12px;
    background: var(--sd-chat-code-bg); padding: 1px 4px; border-radius: 4px;
  }
  .claude-chat .md pre {
    background: var(--sd-chat-code-bg); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0;
  }
  .claude-chat .md pre code { background: none; padding: 0; }
  .claude-chat .md hr { border: none; border-top: 1px solid var(--sd-chat-ctl); margin: 10px 0; }
  .claude-chat .md blockquote {
    border-left: 2px solid var(--sd-chat-ctl); margin: 6px 0; padding-left: 10px; color: var(--sd-chat-quote);
  }
  .claude-chat .md table { border-collapse: collapse; margin: 6px 0; }
  .claude-chat .md td, .claude-chat .md th { border: 1px solid var(--sd-chat-ctl); padding: 3px 6px; }
  .claude-chat .chat-input { display: flex; gap: 8px; padding: 8px 14px 12px; align-items: flex-end; }
  .claude-chat .chat-input textarea {
    flex: 1; resize: none; padding: 8px 12px; font-size: 13px; font-family: inherit;
    border: 1px solid var(--sd-chat-ctl); border-radius: 8px; background: var(--sd-chat-surface); color: var(--sd-chat-ink);
    min-height: 36px; max-height: 120px;
  }
  .claude-chat .chat-input textarea::placeholder { color: var(--sd-chat-faint); }
  .claude-chat .chat-input textarea:focus { outline: none; border-color: var(--sd-accent); }
  .claude-chat .chat-input textarea:disabled { background: var(--sd-chat-input-off); color: var(--sd-chat-faint); }
  .claude-chat .typing { display: inline-flex; gap: 3px; align-items: center; padding: 10px 14px; }
  .claude-chat .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--sd-chat-muted); animation: claude-chat-blink 1.2s infinite; }
  .claude-chat .typing span:nth-child(2) { animation-delay: 0.2s; }
  .claude-chat .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes claude-chat-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
`;

const EMPTY: ChatState = {
  messages: [],
  loaded: false,
  sessionId: null,
  sessionCount: 0,
  updatedAt: null,
  error: null,
  sending: false,
};

const turnFailed = (error?: string | null) =>
  `Turn failed — ${error || "unknown error"}. You can retry, or open it with ↗ Continue in Terminal.`;
const SEND_FAILED =
  "Couldn’t start the turn — check that the session and `claude` CLI are reachable, then retry.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** A Claude chat panel for session `name`; it holds no socket and polls slowly while hidden. */
export function ChatPanel(p: ChatPanelProps) {
  return p.bridge.streamSession ? <StreamedChat {...p} /> : <PolledChat {...p} />;
}

/** Browser surface: live SSE stream (see ChatBridge.streamSession). */
function StreamedChat(p: ChatPanelProps) {
  const { name, bridge } = p;
  const pageVisible = usePageVisible();
  const live = (p.visible ?? true) && pageVisible;
  const [st, setSt] = useState<ChatState>(EMPTY);
  const [pinned, setPinned] = useState<string>();
  // Bumped by Refresh: start the stream over from entry 0.
  const [epoch, setEpoch] = useState(0);
  const [inputBusy, setInputBusy] = useState(false);
  const entries = useRef<ClaudeMessage[]>([]);
  const seenIndex = useRef(-1);
  const streamKey = useRef("");

  useEffect(() => {
    if (!live) return;
    // Hiding and showing reconnects from `seenIndex` so the server skips backfill we
    // hold; a new pin or Refresh changes the key and starts over.
    const key = `${pinned ?? ""}|${epoch}`;
    if (streamKey.current && streamKey.current !== key) {
      entries.current = [];
      seenIndex.current = -1;
      setSt((s) => ({ ...EMPTY, sessionCount: s.sessionCount }));
    }
    streamKey.current = key;
    // Backfill arrives as a burst of entries: render them once per frame.
    let raf = 0;
    const flush = () => {
      raf ||= requestAnimationFrame(() => {
        raf = 0;
        setSt((s) => ({ ...s, messages: entries.current.filter(Boolean) }));
      });
    };
    const unsubscribe = bridge.streamSession?.(
      name,
      {
        onEntry(index, message) {
          entries.current[index] = message;
          seenIndex.current = Math.max(seenIndex.current, index);
          flush();
        },
        onTurn(state, error) {
          setSt((s) => ({
            ...s,
            sending: state === "running",
            error: state === "failed" ? turnFailed(error) : s.error,
          }));
        },
        onReady(meta) {
          setSt((s) =>
            meta
              ? {
                  ...s,
                  loaded: true,
                  sessionId: meta.sessionId,
                  sessionCount: meta.sessionCount,
                  updatedAt: meta.updatedAt,
                }
              : { ...s, loaded: true },
          );
        },
      },
      Math.max(0, seenIndex.current),
      pinned,
    );
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe?.();
    };
  }, [live, pinned, epoch, name, bridge]);

  // Tell the host only when "waiting for input" flips, so entry spam doesn't thrash its list.
  const onActivity = useRef(p.onActivity);
  onActivity.current = p.onActivity;
  const lastWaiting = useRef<boolean | null>(null);
  useEffect(() => {
    if (!st.loaded) return;
    const waiting = !st.sending && st.messages.at(-1)?.role === "assistant";
    if (waiting === lastWaiting.current) return;
    lastWaiting.current = waiting;
    onActivity.current?.({ waiting, running: st.sending });
  }, [st.loaded, st.messages, st.sending]);

  const send = async (text: string) => {
    setInputBusy(true);
    // The typing dots show until the stream reports the turn.
    setSt((s) => ({ ...s, error: null, sending: true }));
    try {
      await bridge.callTool("claude-send", { workspace: name, message: text, sessionId: pinned });
    } catch {
      setSt((s) => ({ ...s, error: SEND_FAILED, sending: false }));
    }
    setInputBusy(false);
  };

  return (
    <ChatView
      {...p}
      st={st}
      pinned={pinned}
      inputDisabled={inputBusy}
      onPin={setPinned}
      onRefresh={() => setEpoch((e) => e + 1)}
      onSend={send}
      onError={(error) => setSt((s) => ({ ...s, error }))}
    />
  );
}

/** Desktop-inline: poll `claude-transcript` / `claude-turn-status`. */
function PolledChat(p: ChatPanelProps) {
  const { name, bridge } = p;
  const pageVisible = usePageVisible();
  const live = useRef(false);
  live.current = (p.visible ?? true) && pageVisible;
  const [st, setSt] = useState<ChatState>(EMPTY);
  // The poll loop outlives renders, so it reads and writes state through this ref.
  const current = useRef(st);
  const set = (patch: Partial<ChatState>) => {
    current.current = { ...current.current, ...patch };
    setSt(current.current);
  };
  const [pinned, setPinned] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  // Each load (and unmount) bumps this; a poll loop from an older one sees it and stops.
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    current.current = { ...EMPTY, sessionCount: current.current.sessionCount };
    setSt(current.current);
    bridge.callTool("claude-transcript", { workspace: name, limit: 20, sessionId: pinned }).then(
      (d) => {
        if (g === gen.current)
          set({
            messages: d.messages || [],
            sessionId: d.sessionId,
            sessionCount: d.sessionCount || 0,
            updatedAt: d.updatedAt,
            loaded: true,
          });
      },
      () => {
        if (g === gen.current)
          set({
            loaded: true,
            error: "Couldn’t load the session — is the Werkmeister server up to date?",
          });
      },
    );
    return () => {
      gen.current++;
    };
  }, [name, bridge, pinned, epoch]);

  const sync = async (g: number) => {
    const d = await bridge.callTool("claude-transcript", {
      workspace: name,
      limit: 30,
      sessionId: pinned,
    });
    const messages: ClaudeMessage[] = d.messages || [];
    const changed =
      g === gen.current && JSON.stringify(messages) !== JSON.stringify(current.current.messages);
    if (changed)
      set({
        messages,
        sessionId: d.sessionId,
        sessionCount: d.sessionCount || 0,
        updatedAt: d.updatedAt,
      });
    return { changed, lastRole: current.current.messages.at(-1)?.role ?? null };
  };

  // Resource-conscious polling: visible → transcript sync every 3s; hidden →
  // only the cheap in-memory turn-status every 12s. Final sync when the turn ends.
  const pollForReply = async (g: number): Promise<boolean> => {
    const deadline = Date.now() + 30 * 60 * 1000;
    let lastChange = Date.now();
    let sawAssistant = false;
    while (Date.now() < deadline && g === gen.current) {
      await sleep(live.current ? 3000 : 12000);
      if (live.current) {
        try {
          const r = await sync(g);
          if (r.changed) {
            lastChange = Date.now();
            if (r.lastRole === "assistant") sawAssistant = true;
          }
        } catch {
          /* transient */
        }
      }
      let status: { state?: string; error?: string } | null = null;
      try {
        status = await bridge.callTool("claude-turn-status", { workspace: name });
      } catch {
        /* older server — heuristic below */
      }
      if (status?.state === "done" || status?.state === "failed") {
        if (status.state === "failed" && g === gen.current)
          set({ error: turnFailed(status.error) });
        try {
          await sync(g);
        } catch {
          /* ignore */
        }
        return true;
      }
      if ((!status || status.state === "idle") && sawAssistant && Date.now() - lastChange > 15000)
        return true;
    }
    return sawAssistant;
  };

  const send = async (text: string) => {
    const g = gen.current;
    set({
      messages: [...current.current.messages, { role: "user", text }],
      error: null,
      sending: true,
    });
    let error: string | null = null;
    try {
      await bridge.callTool("claude-send", { workspace: name, message: text, sessionId: pinned });
      if (!(await pollForReply(g)))
        error =
          "Claude is still working after 30 min — hit Refresh later, or open it with ↗ Continue in Terminal.";
    } catch {
      error = SEND_FAILED;
    }
    if (g === gen.current) set(error ? { error, sending: false } : { sending: false });
  };

  return (
    <ChatView
      {...p}
      st={st}
      pinned={pinned}
      inputDisabled={st.sending}
      onPin={setPinned}
      onRefresh={() => setEpoch((e) => e + 1)}
      onSend={send}
      onError={(error) => set({ error })}
    />
  );
}

interface SessionOption {
  sessionId: string;
  title: string;
  updatedAt: string;
  isNewest: boolean;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Message({
  m,
  renderMarkdown,
}: {
  m: ClaudeMessage;
  renderMarkdown?: (src: string) => string;
}) {
  if (m.role === "tool")
    return (
      <div className="msg-tool" title={m.text}>
        ⚙ {m.text}
      </div>
    );
  // Assistant replies are markdown-heavy; user bubbles stay the literal typed prompt.
  if (m.role === "assistant" && renderMarkdown)
    return (
      <div
        className="msg msg-assistant md"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown is html:false (XSS-safe) by contract
        dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
      />
    );
  return <div className={`msg msg-${m.role}`}>{m.text}</div>;
}

/** The panel's markup, shared by both transports. Exported for tests. */
export function ChatView(
  p: ChatPanelProps & {
    st: ChatState;
    pinned?: string;
    inputDisabled: boolean;
    onPin(sessionId: string | undefined): void;
    onRefresh(): void;
    onSend(text: string): Promise<void>;
    onError(message: string): void;
  },
) {
  const { st, name, bridge } = p;
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState(false);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [optionsShown, setOptionsShown] = useState(false);
  const msgs = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const refocus = useRef(false);

  // Session picker: only with ≥2 sessions, rebuilt when the count changes.
  const builtFor = useRef(-1);
  useEffect(() => {
    if (!st.loaded || st.sessionCount === builtFor.current) return;
    if (st.sessionCount < 2) {
      builtFor.current = st.sessionCount;
      setSessions([]);
      return;
    }
    let stale = false;
    bridge.callTool("claude-transcript", { workspace: name, limit: 1 }).then(
      (d) => {
        const list: SessionOption[] = d.sessions || [];
        if (stale || list.length < 2) return;
        builtFor.current = st.sessionCount;
        setSessions(list);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [st.loaded, st.sessionCount, name, bridge]);

  // Terminal-spawned sessions emit no "turn done" event, so the reply going quiet
  // for 2s counts as "analysis finished": every new message restarts the timer.
  const replied = !st.sending && st.messages.some((m) => m.role === "assistant");
  const hasOptions = !!p.decisionOptions;
  useEffect(() => {
    if (optionsShown || !hasOptions || !replied) return;
    const timer = setTimeout(() => setOptionsShown(true), 2000);
    return () => clearTimeout(timer);
  }, [optionsShown, hasOptions, replied, st.messages]);

  useLayoutEffect(() => {
    if (msgs.current) msgs.current.scrollTop = msgs.current.scrollHeight;
  });

  // A disabled textarea can't take focus, so refocus once the send settles.
  useEffect(() => {
    if (p.inputDisabled || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [p.inputDisabled]);

  const submit = () => {
    const text = draft.trim();
    if (!text || st.sending) return;
    setDraft("");
    refocus.current = true;
    void p.onSend(text);
  };

  const resume = async () => {
    setOpening(true);
    try {
      await bridge.callTool("claude-resume", { workspace: name, sessionId: p.pinned });
    } catch {
      p.onError("Couldn’t open Terminal — is the session reachable?");
    }
    setOpening(false);
  };

  let info = "";
  if (st.loaded && st.sessionId)
    info =
      `${st.sessionId.slice(0, 8)}…` +
      (st.sessionCount > 1 ? ` · ${st.sessionCount} sessions` : "") +
      (st.updatedAt ? ` · ${new Date(st.updatedAt).toLocaleString()}` : "");
  else if (st.loaded) info = "no sessions yet — sending starts one";

  return (
    <div className="claude-chat">
      <Css id="claude-chat" css={CHAT_CSS} />
      <div className="chat-head">
        <span className="chat-title">Claude session</span>
        {sessions.length ? (
          <select
            className="chat-picker"
            title="Choose which Claude session to view and message"
            value={p.pinned || sessions[0].sessionId}
            // The newest session is "unpinned": the view follows session rolls.
            onChange={(e) =>
              p.onPin(e.target.value === sessions[0].sessionId ? undefined : e.target.value)
            }
          >
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {(s.isNewest ? "● " : "") + s.title + " · " + shortDate(s.updatedAt)}
              </option>
            ))}
          </select>
        ) : (
          <span>{info}</span>
        )}
        <button type="button" className="btn" onClick={p.onRefresh}>
          Refresh
        </button>
        <button type="button" className="btn" disabled={opening} onClick={() => void resume()}>
          {opening ? "Opening…" : "↗ Continue in Terminal"}
        </button>
      </div>
      <div className="chat-msgs" ref={msgs}>
        {st.loaded ? (
          <>
            {!st.messages.length && <div className="msg-info">No messages yet.</div>}
            {st.messages.map((m, i) => (
              // Entries are index-addressed and append-only.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <Message key={i} m={m} renderMarkdown={p.renderMarkdown} />
            ))}
            {st.error && <div className="msg-err">{st.error}</div>}
            {st.sending && (
              <div className="msg msg-assistant typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </>
        ) : (
          <div className="msg-info">Loading session…</div>
        )}
      </div>
      <div style={{ padding: "0 14px" }}>
        {optionsShown && p.decisionOptions && <OptionsInput {...p.decisionOptions} />}
      </div>
      <div className="chat-input">
        <textarea
          ref={input}
          rows={1}
          placeholder={p.placeholder ?? "Message this Claude session…"}
          value={draft}
          disabled={p.inputDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn primary" disabled={p.inputDisabled} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * Embedded Claude Code chat panel — the single component behind both the
 * Workspaces tab (per-workspace session) and the Open-Pull-Requests tab (a
 * `reconcile:<repo>-<number>` session). It was factored out of workspace-ui.ts
 * so the two surfaces share ONE chat UI rather than drifting apart.
 *
 * Keyed by an opaque `name` (a workspace name OR a `reconcile:` session key);
 * the server resolves it to a directory (sandbox-core `resolveSessionDir`).
 * The browser surface live-streams over SSE (`bridge.streamSession`); hosts
 * that leave it undefined (Desktop-inline, Cowork artifact) fall back to
 * `claude-transcript` / `claude-turn-status` polling.
 *
 * ponytail: DEPENDENCY-FREE (no React/JSX) and self-contained — it injects its
 * own `.claude-chat`-scoped CSS and full button styles so it renders identically
 * no matter which page hosts it. It owns its per-panel state in a closure (the
 * host caches the returned element, so state survives re-renders). The one link
 * back to a host list is the optional `onActivity` hook (drives the "waiting for
 * input" badge on the Workspaces list); the PR page just omits it.
 */
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
      onReady(meta?: { sessionId: string | null; sessionCount: number; updatedAt: string | null }): void;
    },
    fromIndex?: number,
    sessionId?: string,
  ): () => void;
}

import { createOptionsInput, type OptionsInputOpts } from "./options-input.js";
import { el, injectCss } from "./theme.js";

export interface ChatPanelOpts {
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
}

export interface ChatPanelHandle {
  el: HTMLElement;
  onExpand?: () => void;
  onVisibility?: (visible: boolean) => void;
}

const CHAT_CSS = `
  .claude-chat { border-top: 1px solid #3a3a38; background: #1e1e1c; }
  .claude-chat, .claude-chat * { box-sizing: border-box; }
  .claude-chat .chat-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 11px; color: #8a8a84; }
  .claude-chat .btn {
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    padding: 3px 8px; border-radius: 6px; border: 1px solid #4a4a47; background: #2c2c2a; color: #d0d0cb;
  }
  .claude-chat .btn:hover { background: #3a3a38; }
  .claude-chat .btn:disabled { opacity: 0.5; cursor: default; }
  .claude-chat .btn.primary { background: var(--sd-accent); border-color: var(--sd-accent); color: #fff; }
  .claude-chat .btn.primary:hover { background: var(--sd-accent-hover); }
  .claude-chat .chat-title { font-weight: 700; color: #a0a09a; text-transform: uppercase; letter-spacing: 0.05em; }
  .claude-chat .chat-picker {
    flex: 1; min-width: 0; max-width: 320px; font: inherit; font-size: 11px;
    padding: 3px 6px; background: #2c2c2a; color: #d0d0cb;
    border: 1px solid #4a4a47; border-radius: 6px;
  }
  .claude-chat .chat-msgs { max-height: 320px; overflow-y: auto; padding: 4px 14px 8px; display: flex; flex-direction: column; gap: 8px; scrollbar-color: #4a4a47 #1e1e1c; }
  .claude-chat .chat-msgs::-webkit-scrollbar { width: 8px; }
  .claude-chat .chat-msgs::-webkit-scrollbar-thumb { background: #4a4a47; border-radius: 4px; }
  .claude-chat .chat-msgs::-webkit-scrollbar-track { background: #1e1e1c; }
  .claude-chat .msg { max-width: 82%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .claude-chat .msg-user { align-self: flex-end; background: var(--sd-accent); color: #fff; border-bottom-right-radius: 4px; }
  .claude-chat .msg-assistant { align-self: flex-start; background: #2c2c2a; border: 1px solid #3f3f3c; color: #e8e8e3; border-bottom-left-radius: 4px; }
  .claude-chat .msg-tool {
    align-self: flex-start; max-width: 95%; padding: 1px 4px;
    font-family: var(--sd-mono); font-size: 11px;
    color: #8a8a84; background: transparent; border-radius: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .claude-chat .msg-info { align-self: center; font-size: 11px; color: #7a7a74; padding: 2px 0; }
  .claude-chat .msg-err { align-self: center; font-size: 12px; color: #e07a6a; padding: 2px 0; }
  /* Rendered-markdown assistant bubbles (opts.renderMarkdown). These rules come
     after .msg so .md's white-space:normal wins over .msg's pre-wrap. */
  .claude-chat .md { white-space: normal; }
  .claude-chat .md > :first-child { margin-top: 0; }
  .claude-chat .md > :last-child { margin-bottom: 0; }
  .claude-chat .md h1, .claude-chat .md h2, .claude-chat .md h3, .claude-chat .md h4 {
    margin: 10px 0 6px; font-size: 13px; font-weight: 700; color: #f0f0eb; line-height: 1.3;
  }
  .claude-chat .md p { margin: 6px 0; }
  .claude-chat .md ul, .claude-chat .md ol { margin: 6px 0; padding-left: 20px; }
  .claude-chat .md li { margin: 2px 0; }
  .claude-chat .md strong { color: #f6f6f1; font-weight: 700; }
  .claude-chat .md a { color: #e0a892; }
  .claude-chat .md code {
    font-family: var(--sd-mono); font-size: 12px;
    background: #1a1a18; padding: 1px 4px; border-radius: 4px;
  }
  .claude-chat .md pre {
    background: #1a1a18; padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0;
  }
  .claude-chat .md pre code { background: none; padding: 0; }
  .claude-chat .md hr { border: none; border-top: 1px solid #4a4a47; margin: 10px 0; }
  .claude-chat .md blockquote {
    border-left: 2px solid #4a4a47; margin: 6px 0; padding-left: 10px; color: #b0b0aa;
  }
  .claude-chat .md table { border-collapse: collapse; margin: 6px 0; }
  .claude-chat .md td, .claude-chat .md th { border: 1px solid #4a4a47; padding: 3px 6px; }
  .claude-chat .chat-input { display: flex; gap: 8px; padding: 8px 14px 12px; align-items: flex-end; }
  .claude-chat .chat-input textarea {
    flex: 1; resize: none; padding: 8px 12px; font-size: 13px; font-family: inherit;
    border: 1px solid #4a4a47; border-radius: 8px; background: #2c2c2a; color: #e8e8e3;
    min-height: 36px; max-height: 120px;
  }
  .claude-chat .chat-input textarea::placeholder { color: #7a7a74; }
  .claude-chat .chat-input textarea:focus { outline: none; border-color: var(--sd-accent); }
  .claude-chat .chat-input textarea:disabled { background: #262624; color: #7a7a74; }
  .claude-chat .typing { display: inline-flex; gap: 3px; align-items: center; padding: 10px 14px; }
  .claude-chat .typing span { width: 6px; height: 6px; border-radius: 50%; background: #8a8a84; animation: claude-chat-blink 1.2s infinite; }
  .claude-chat .typing span:nth-child(2) { animation-delay: 0.2s; }
  .claude-chat .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes claude-chat-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a Claude chat panel for session `name`. Returns the element plus the
 * expand/visibility lifecycle hooks the host wires (they gate the SSE socket /
 * poll cadence so a hidden panel holds nothing open).
 */
export function initChatPanel(name: string, opts: ChatPanelOpts): ChatPanelHandle {
  injectCss("claude-chat", CHAT_CSS);
  const { bridge } = opts;
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  // Per-panel state (closure, not a shared map — the host caches our element so
  // this survives its re-renders). The polling path REPLACES this object on each
  // reload, so every inner closure reads `st` fresh via this binding.
  let st: any = { messages: [], loaded: false };
  let visible = false;

  const box = el("div", "claude-chat");
  const head = el("div", "chat-head");
  head.appendChild(el("span", "chat-title", "Claude session"));
  const info = el("span", null, "");
  head.appendChild(info);
  const refresh = el("button", "btn", "Refresh") as HTMLButtonElement;
  head.appendChild(refresh);
  // Open the *picked* session (or newest) in a real Terminal for a fully
  // interactive session. Honors the session selector via st.pinnedSessionId.
  const resume = el("button", "btn", "Resume in Terminal") as HTMLButtonElement;
  head.appendChild(resume);
  resume.addEventListener("click", async () => {
    const orig = resume.textContent;
    resume.disabled = true;
    resume.textContent = "Opening…";
    try {
      await call("claude-resume", { name, sessionId: st?.pinnedSessionId });
    } catch {
      if (st) { st.error = "Couldn’t open Terminal — is the session reachable?"; renderMsgs(); }
    }
    resume.textContent = orig;
    resume.disabled = false;
  });
  box.appendChild(head);

  // Session picker: a native <select> shown only when there are ≥2 sessions.
  // Picking one pins the view + retargets send/resume via st.pinnedSessionId
  // (empty = newest = default). Each surface supplies its own onPick.
  function setupSessionPicker(onPick: () => void): (sessionCount: number) => Promise<void> {
    const picker = document.createElement("select");
    picker.className = "chat-picker";
    picker.hidden = true;
    picker.title = "Choose which Claude session to view and message";
    head.insertBefore(picker, refresh);
    let builtFor = -1; // last sessionCount the options were built for
    const shortDate = (iso: string) =>
      new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    picker.addEventListener("change", () => {
      if (!st) return;
      // Newest option = unpinned (follow rolls); anything else pins.
      st.pinnedSessionId = picker.value === picker.options[0]?.value ? undefined : picker.value;
      onPick();
    });
    return async (sessionCount: number) => {
      if (sessionCount < 2) { picker.hidden = true; info.hidden = false; builtFor = sessionCount; return; }
      if (sessionCount === builtFor) return;
      let sessions: Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>;
      try {
        sessions = (await call("claude-transcript", { name, limit: 1 })).sessions || [];
      } catch { return; }
      if (sessions.length < 2) return;
      builtFor = sessionCount;
      picker.replaceChildren();
      for (const s of sessions) {
        const opt = document.createElement("option");
        opt.value = s.sessionId;
        opt.textContent = (s.isNewest ? "● " : "") + s.title + " · " + shortDate(s.updatedAt);
        picker.appendChild(opt);
      }
      picker.value = st?.pinnedSessionId || sessions[0].sessionId;
      picker.hidden = false;
      info.hidden = true;
    };
  }

  const msgs = el("div", "chat-msgs");
  box.appendChild(msgs);

  // Decision widget host (reconcile flow). Built once, after the turn settles.
  const optionsHost = el("div");
  optionsHost.style.padding = "0 14px";
  box.appendChild(optionsHost);
  let optionsShown = false;
  let optionsTimer: ReturnType<typeof setTimeout> | null = null;
  // Terminal-spawned sessions emit no "turn done" event, so we treat the reply
  // going quiet as "analysis finished": each new entry resets a debounce, and the
  // widget appears ~2s after the last change. `maybeShowOptions` runs on every
  // render, so streaming keeps pushing the timer out until the reply settles.
  function maybeShowOptions(): void {
    if (optionsShown || !opts.decisionOptions) return;
    const ready = st && !st.sending && (st.messages || []).some((m: ClaudeMessage) => m.role === "assistant");
    if (!ready) {
      if (optionsTimer) { clearTimeout(optionsTimer); optionsTimer = null; }
      return;
    }
    if (optionsTimer) clearTimeout(optionsTimer);
    optionsTimer = setTimeout(() => {
      optionsTimer = null;
      if (optionsShown) return;
      optionsShown = true;
      optionsHost.appendChild(createOptionsInput(opts.decisionOptions!));
    }, 2000);
  }

  const inputRow = el("div", "chat-input");
  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.placeholder = opts.placeholder ?? "Message this Claude session…";
  const send = el("button", "btn primary", "Send") as HTMLButtonElement;
  inputRow.appendChild(ta);
  inputRow.appendChild(send);
  box.appendChild(inputRow);

  function msgNode(role: string, text: string): HTMLElement {
    if (role === "tool") {
      const t = el("div", "msg-tool", "⚙ " + text);
      t.title = text;
      return t;
    }
    // Assistant replies are markdown-heavy — render them (html:false → XSS-safe)
    // when the host injected a renderer. User bubbles stay plain text (the
    // literal typed prompt). Surfaces without a renderer show plain text.
    if (role === "assistant" && opts.renderMarkdown) {
      const t = el("div", "msg msg-assistant md");
      t.innerHTML = opts.renderMarkdown(text);
      return t;
    }
    return el("div", "msg msg-" + role, text);
  }

  function scrollDown(): void {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function renderMsgs(): void {
    msgs.innerHTML = "";
    if (!st || !st.loaded) {
      msgs.appendChild(el("div", "msg-info", "Loading session…"));
      return;
    }
    if (st.sessionId) {
      info.textContent =
        st.sessionId.slice(0, 8) + "…" +
        (st.sessionCount > 1 ? " · " + st.sessionCount + " sessions" : "") +
        (st.updatedAt ? " · " + new Date(st.updatedAt).toLocaleString() : "");
    } else {
      info.textContent = "no sessions yet — sending starts one";
    }
    if (!st.messages.length) msgs.appendChild(el("div", "msg-info", "No messages yet."));
    for (const m of st.messages) msgs.appendChild(msgNode(m.role, m.text));
    if (st.error) msgs.appendChild(el("div", "msg-err", st.error));
    if (st.sending) {
      const t = el("div", "msg msg-assistant typing");
      t.appendChild(el("span"));
      t.appendChild(el("span"));
      t.appendChild(el("span"));
      msgs.appendChild(t);
    }
    maybeShowOptions();
    scrollDown();
  }

  // ---- Browser surface: live SSE stream (see ChatBridge.streamSession) ----
  // Everything below this block is the polling fallback the Desktop-inline
  // and Cowork-artifact surfaces take (they leave streamSession undefined).
  if (bridge.streamSession) {
    const entries: ClaudeMessage[] = (st.entries = st.entries || []);

    // Picking a session re-backfills from the pinned file (fresh reconnect).
    const syncPicker = setupSessionPicker(() => connect({ fresh: true }));

    let raf = 0;
    const scheduleRender = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        st.messages = entries.filter(Boolean);
        renderMsgs();
        syncActivity();
      });
    };

    // Fire onActivity only when "waiting for input" flips, so entry-spam
    // doesn't thrash the host's list. waiting = turn not running AND Claude
    // spoke last.
    let lastWaiting: boolean | null = null;
    const syncActivity = () => {
      if (!opts.onActivity) return;
      const last = entries.filter(Boolean).at(-1);
      const waiting = !st.sending && last?.role === "assistant";
      if (waiting !== lastWaiting) {
        lastWaiting = waiting;
        opts.onActivity({ waiting, running: !!st.sending });
      }
    };

    let unsub: (() => void) | null = null;
    let seenIndex = -1; // highest entry index applied → resume cursor across reconnects
    const handlers = {
      onEntry(index: number, m: ClaudeMessage) {
        entries[index] = m;
        if (index > seenIndex) seenIndex = index;
        scheduleRender();
      },
      onTurn(state: "running" | "done" | "failed", error?: string | null) {
        st.sending = state === "running";
        if (state === "failed") {
          st.error = "Turn failed — " + (error || "unknown error") +
            ". You can retry, or open it with Resume in Terminal.";
        }
        scheduleRender();
      },
      onReady(meta?: { sessionId: string | null; sessionCount: number; updatedAt: string | null }) {
        st.loaded = true;
        if (meta) {
          st.sessionId = meta.sessionId;
          st.sessionCount = meta.sessionCount;
          st.updatedAt = meta.updatedAt;
          void syncPicker(meta.sessionCount);
        }
        scheduleRender();
      },
    };

    // Connection is gated on visibility (see the returned onVisibility hook).
    // Reconnect resumes from `seenIndex` so the server skips backfill the
    // client already holds; `fresh` (Refresh) starts over from index 0.
    const connect = (o?: { fresh?: boolean }) => {
      if (o?.fresh) {
        disconnect();
        entries.length = 0;
        seenIndex = -1;
        st.loaded = false;
        st.error = null;
        st.sending = false;
        scheduleRender();
      }
      if (unsub) return; // already connected
      unsub = bridge.streamSession!(name, handlers, Math.max(0, seenIndex), st.pinnedSessionId);
    };
    function disconnect(): void {
      if (unsub) {
        unsub();
        unsub = null;
      }
    }

    const sendStream = async (): Promise<void> => {
      const text = ta.value.trim();
      if (!text || st.sending) return;
      ta.value = "";
      ta.disabled = true;
      send.disabled = true;
      st.error = null;
      st.sending = true; // typing indicator until the stream reports the turn
      scheduleRender();
      try {
        await call("claude-send", { name, message: text, sessionId: st.pinnedSessionId });
      } catch (e) {
        st.error = "Couldn’t start the turn — check that the session and `claude` CLI are reachable, then retry.";
        st.sending = false;
      }
      ta.disabled = false;
      send.disabled = false;
      scheduleRender();
      ta.focus();
    };

    send.addEventListener("click", () => void sendStream());
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendStream();
      }
    });
    refresh.addEventListener("click", () => connect({ fresh: true }));
    // Visibility gating: a hidden/collapsed panel holds no socket and no
    // server-side tailer.
    connect(); // built while visible (host mounts us on expand)
    visible = true;
    return {
      el: box,
      onVisibility: (v: boolean) => {
        visible = v;
        if (v) connect();
        else disconnect();
      },
    };
  }

  // ---- Polling fallback (Desktop-inline + Cowork artifact) ----
  async function loadTranscript(force: boolean): Promise<void> {
    if (st && st.loaded && !force) {
      renderMsgs();
      return;
    }
    const pinned = st?.pinnedSessionId; // survive reload/switch
    st = { messages: [], sessionId: null, loaded: false, pinnedSessionId: pinned };
    renderMsgs();
    try {
      const d = await call("claude-transcript", { name, limit: 20, sessionId: pinned });
      st = {
        messages: d.messages || [],
        sessionId: d.sessionId,
        sessionCount: d.sessionCount || 0,
        updatedAt: d.updatedAt,
        loaded: true,
        pinnedSessionId: pinned,
      };
    } catch (e) {
      st = {
        messages: [], sessionId: null, loaded: true, pinnedSessionId: pinned,
        error: "Couldn’t load the session — is the Sandbox server up to date?",
      };
    }
    void syncPickerPoll(st.sessionCount || 0);
    renderMsgs();
  }

  async function syncTranscript(state: any): Promise<{ changed: boolean; lastRole: string | null }> {
    const d = await call("claude-transcript", { name, limit: 30, sessionId: state.pinnedSessionId });
    const changed = JSON.stringify(d.messages || []) !== JSON.stringify(state.messages);
    if (changed) {
      state.messages = d.messages || [];
      state.sessionId = d.sessionId;
      state.sessionCount = d.sessionCount;
      state.updatedAt = d.updatedAt;
      renderMsgs();
    }
    return { changed, lastRole: state.messages.length ? state.messages[state.messages.length - 1].role : null };
  }

  // Resource-conscious polling: visible → transcript sync every 3s; hidden →
  // only the cheap in-memory turn-status every 12s. Final sync when the turn ends.
  const panelVisible = () => visible && !document.hidden;

  async function pollForReply(state: any): Promise<boolean> {
    const deadline = Date.now() + 30 * 60 * 1000;
    let lastChange = Date.now();
    let sawAssistant = false;
    while (Date.now() < deadline && state.sending) {
      await sleep(panelVisible() ? 3000 : 12000);
      if (panelVisible()) {
        try {
          const r = await syncTranscript(state);
          if (r.changed) {
            lastChange = Date.now();
            if (r.lastRole === "assistant") sawAssistant = true;
          }
        } catch (e) { /* transient */ }
      }
      let status: any = null;
      try {
        status = await call("claude-turn-status", { name });
      } catch (e) { /* older server — heuristic below */ }
      if (status && (status.state === "done" || status.state === "failed")) {
        if (status.state === "failed") {
          state.error = "Turn failed — " + (status.error || "unknown error") + ". You can retry, or open it with Resume in Terminal.";
        }
        try { await syncTranscript(state); } catch (e) { /* ignore */ }
        return true;
      }
      if (!status || status.state === "idle") {
        if (sawAssistant && Date.now() - lastChange > 15000) return true;
      }
    }
    return sawAssistant;
  }

  async function sendMsg(): Promise<void> {
    const text = ta.value.trim();
    if (!text || !st || st.sending) return;
    ta.value = "";
    ta.disabled = true;
    send.disabled = true;
    st.messages.push({ role: "user", text });
    st.error = null;
    st.sending = true;
    renderMsgs();
    try {
      await call("claude-send", { name, message: text, sessionId: st.pinnedSessionId });
      const settled = await pollForReply(st);
      if (!settled) st.error = "Claude is still working after 30 min — hit Refresh later, or open it with Resume in Terminal.";
    } catch (e) {
      st.error = "Couldn’t start the turn — check that the session and `claude` CLI are reachable, then retry.";
    }
    st.sending = false;
    ta.disabled = false;
    send.disabled = false;
    renderMsgs();
    ta.focus();
  }

  send.addEventListener("click", () => void sendMsg());
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendMsg();
    }
  });
  refresh.addEventListener("click", () => void loadTranscript(true));

  // Picking a session reloads the transcript for the pinned id.
  const syncPickerPoll = setupSessionPicker(() => void loadTranscript(true));

  void loadTranscript(false);
  return {
    el: box,
    onVisibility: (v: boolean) => { visible = v; },
    onExpand: async () => {
      if (!st || !st.loaded || st.sending) return;
      let running = false;
      try {
        const s = await call("claude-turn-status", { name });
        running = s.state === "running";
      } catch (e) { /* no status tool — plain sync */ }
      if (running) {
        st.error = null;
        st.sending = true;
        renderMsgs();
        await pollForReply(st);
        st.sending = false;
        renderMsgs();
      } else {
        try { await syncTranscript(st); } catch (e) { /* ignore */ }
      }
    },
  };
}

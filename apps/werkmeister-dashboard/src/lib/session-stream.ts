/**
 * Per-workspace live tailer over Claude Code's session JSONL — the server half
 * of the browser dashboard's streaming chat (see docs/browser-chat-streaming
 * handoff). Ports vibe-kanban's model (a history buffer + broadcast, delivered
 * as "backfill then live tail" with index-addressed idempotent deltas) without
 * its mechanism: no Rust/tokio/WebSocket, and no stream-json stdout capture.
 *
 * Source of truth is the file Claude Code already appends to, so turns we
 * didn't start (an external `claude --resume` in the same workspace) stream too
 * — the same property the old poller had. One tailer per workspace, ref-counted
 * by subscribers; the watchers/interval tear down at zero subscribers.
 *
 * ponytail: on any change we re-read and re-parse the WHOLE file, then diff
 * against the last entries by index — the exact cost the 3s poller already
 * paid, but pushed on append instead of on a clock, and robust to partial-line
 * writes and multi-message lines. Upgrade to byte-offset tailing only if large
 * transcripts measurably lag.
 */
import fs from "node:fs";
import {
  type ClaudeMessage,
  getClaudeTurnStatus,
  parseSessionLines,
  resolveSessionSource,
  turnEvents,
} from "werkmeister-core";

export type StreamEvent =
  | { type: "entry"; index: number; message: ClaudeMessage }
  | { type: "ready"; sessionId: string | null; sessionCount: number; updatedAt: string | null }
  | { type: "turn"; state: "running" | "done" | "failed"; error: string | null };

type Subscriber = (e: StreamEvent) => void;

/** fs.watch coalescing / safety window. fs.watch drives the sub-second path; */
const DEBOUNCE_MS = 120;
/** the safety re-read backstops missed fs.watch events and the cold start */
const SAFETY_MS = 3000; //  (no session dir yet → first send's file appears).

class Tailer {
  entries: ClaudeMessage[] = [];
  sessionFile: string | null = null;
  sessionId: string | null = null;
  sessionCount = 0;
  updatedAt: string | null = null;
  ready: Promise<void> | null = null;

  private subs = new Set<Subscriber>();
  private fileWatcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private watchedDir: string | null = null;
  private rereadTimer: NodeJS.Timeout | null = null;
  private safety: NodeJS.Timeout | null = null;
  private turnListener: (p: { state: "running" | "done" | "failed"; error: string | null }) => void;

  constructor(
    private name: string,
    private readonly pinnedSessionId?: string,
  ) {
    this.turnListener = (p) => {
      this.broadcast({ type: "turn", state: p.state, error: p.error ?? null });
      // A send just wrote the user line (and will grow the reply) — pull it in.
      this.scheduleReread();
    };
  }

  start(): Promise<void> {
    if (!this.ready) {
      this.ready = this.reread().then(() => {
        this.safety = setInterval(() => this.scheduleReread(), SAFETY_MS);
        turnEvents.on(this.name, this.turnListener);
      });
    }
    return this.ready;
  }

  stop(): void {
    turnEvents.off(this.name, this.turnListener);
    this.fileWatcher?.close();
    this.dirWatcher?.close();
    if (this.rereadTimer) clearTimeout(this.rereadTimer);
    if (this.safety) clearInterval(this.safety);
  }

  add(sub: Subscriber, fromIndex: number): void {
    // Backfill everything the subscriber hasn't seen, then signal ready.
    // Index-addressed adds are upserts, so replaying from a Last-Event-ID
    // cursor is idempotent — no client ACKs.
    for (let i = Math.max(0, fromIndex); i < this.entries.length; i++) {
      sub({ type: "entry", index: i, message: this.entries[i] });
    }
    sub({
      type: "ready",
      sessionId: this.sessionId,
      sessionCount: this.sessionCount,
      updatedAt: this.updatedAt,
    });
    // Surface an in-flight turn so a mid-turn (re)connect shows the indicator.
    void getClaudeTurnStatus(this.name)
      .then((s) => {
        if (s.state === "running") sub({ type: "turn", state: "running", error: null });
      })
      .catch(() => {});
    this.subs.add(sub);
  }

  remove(sub: Subscriber): boolean {
    this.subs.delete(sub);
    return this.subs.size === 0;
  }

  private broadcast(e: StreamEvent): void {
    for (const sub of this.subs) sub(e);
  }

  private scheduleReread(): void {
    if (this.rereadTimer) return;
    this.rereadTimer = setTimeout(() => {
      this.rereadTimer = null;
      void this.reread();
    }, DEBOUNCE_MS);
  }

  private async reread(): Promise<void> {
    // Pinned → resolveSessionSource keeps returning the same file, so the
    // `src.sessionFile !== this.sessionFile` roll check below never trips: the
    // tailer stops following rolls for free. Unpinned → follows newest.
    const src = await resolveSessionSource(this.name, this.pinnedSessionId);
    this.sessionId = src.sessionId;
    this.sessionCount = src.sessionCount;
    this.updatedAt = src.updatedAt;
    this.ensureDirWatcher(src.projectDir);
    if (!src.sessionFile) return;

    // Session roll: a new session file became newest → re-backfill from it.
    // (Trailing entries beyond the new file's length stay in the client until
    // the next open; cosmetic, and rare — sends resume the same file.)
    if (src.sessionFile !== this.sessionFile) {
      this.sessionFile = src.sessionFile;
      this.entries = [];
      this.ensureFileWatcher(src.sessionFile);
    }

    let text: string;
    try {
      text = await fs.promises.readFile(src.sessionFile, "utf-8");
    } catch {
      return;
    }
    const next = parseSessionLines(text);
    for (let i = 0; i < next.length; i++) {
      if (i >= this.entries.length || JSON.stringify(next[i]) !== JSON.stringify(this.entries[i])) {
        this.broadcast({ type: "entry", index: i, message: next[i] });
      }
    }
    this.entries = next;
  }

  private ensureDirWatcher(projectDir: string | null): void {
    if (!projectDir || this.watchedDir === projectDir) return;
    this.dirWatcher?.close();
    try {
      // New *.jsonl (session roll) shows up as a dir change → re-resolve.
      this.dirWatcher = fs.watch(projectDir, () => this.scheduleReread());
      this.watchedDir = projectDir;
    } catch {
      this.dirWatcher = null;
    }
  }

  private ensureFileWatcher(file: string): void {
    this.fileWatcher?.close();
    try {
      this.fileWatcher = fs.watch(file, () => this.scheduleReread());
    } catch {
      this.fileWatcher = null;
    }
  }
}

const tailers = new Map<string, Tailer>();

/**
 * Subscribe to a workspace's live session stream. `onEvent` receives the
 * backfill (entries from `fromIndex`, then a `ready`), then live `entry`/`turn`
 * deltas as the JSONL grows. Returns an unsubscribe that tears the tailer down
 * at zero subscribers.
 */
export function subscribeSession(
  name: string,
  onEvent: Subscriber,
  fromIndex = 0,
  sessionId?: string,
): () => void {
  // One tailer per (workspace, pinned session). Unpinned key stays `name`, so
  // the default follow-newest path is byte-for-byte unchanged.
  const key = sessionId ? `${name}::${sessionId}` : name;
  let tailer = tailers.get(key);
  if (!tailer) {
    tailer = new Tailer(name, sessionId);
    tailers.set(key, tailer);
  }
  const t = tailer;
  void t
    .start()
    .then(() => t.add(onEvent, fromIndex))
    .catch(() => onEvent({ type: "ready", sessionId: null, sessionCount: 0, updatedAt: null }));
  return () => {
    if (t.remove(onEvent)) {
      t.stop();
      tailers.delete(key);
    }
  };
}

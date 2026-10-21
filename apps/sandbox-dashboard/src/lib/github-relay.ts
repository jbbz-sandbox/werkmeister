/**
 * GitHub webhook relay over smee.io: a merged PR or a published release
 * triggers the same refresh the PR polls run, seconds after it happens. An
 * event is only a "refresh now" signal; nothing from its payload is kept.
 */

import crypto from "node:crypto";
import express, { type Router } from "express";
import { localOnly } from "./localhost-form.js";

export type RelayEvent = { event: "pull_request" | "release"; repo: string };

/** One smee message: GitHub's headers, lowercased, at the top level; the parsed JSON in `body`. */
export type SmeeMessage = Record<string, unknown> & { body?: unknown };

/** `x-hub-signature-256` is `sha256=<hex HMAC-SHA256 of body>`; false when missing or malformed. */
export function verifySignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(signature.slice("sha256=".length), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Only these trigger a pass: a PR closing (merged or not) and a release going out.
const ACTIONS: Record<RelayEvent["event"], string> = {
  pull_request: "closed",
  release: "published",
};

/**
 * The event a signed smee message carries, or null for a bad signature or an event that
 * triggers nothing. `log` hears only signature failures, the one drop worth knowing about.
 */
export function relayEventOf(
  msg: SmeeMessage,
  secret: string,
  log: (line: string) => void = () => {},
): RelayEvent | null {
  const event = msg["x-github-event"];
  if (event !== "pull_request" && event !== "release") return null;
  const body = (msg.body ?? {}) as { action?: unknown; repository?: { full_name?: unknown } };
  if (body.action !== ACTIONS[event]) return null;
  // smee re-serializes the JSON it received; the signature is checked over that.
  const sig = msg["x-hub-signature-256"];
  if (
    !verifySignature(JSON.stringify(msg.body), typeof sig === "string" ? sig : undefined, secret)
  ) {
    log(`github relay: dropped a ${event} event with a bad or missing signature`);
    return null;
  }
  return { event, repo: String(body.repository?.full_name ?? "") };
}

/**
 * Hold the smee channel open and call `onEvents` once per burst of accepted events,
 * `debounceMs` after the burst's first. Never two `onEvents` at once: events that arrive
 * during one start the next burst. A dropped or refused stream reconnects after `backoffMs`.
 */
export function startGithubRelay(opts: {
  url: string;
  secret: string;
  onEvents: (events: RelayEvent[]) => Promise<void>;
  debounceMs?: number;
  backoffMs?: number[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): { stop(): void } {
  const { url, secret, onEvents } = opts;
  const debounceMs = opts.debounceMs ?? 3000;
  const backoffMs = opts.backoffMs ?? [1000, 5000, 30000];
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((l: string) => console.error(`[workspaces] ${l}`));
  const abort = new AbortController();
  let stopped = false;
  let pending: RelayEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let flushing = false;

  const schedule = () => {
    if (!flushTimer && !flushing && pending.length && !stopped)
      flushTimer = setTimeout(flush, debounceMs);
  };
  const flush = async () => {
    flushTimer = null;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      await onEvents(batch);
    } catch (e) {
      log(`github relay: refresh failed: ${(e as Error).message}`);
    } finally {
      flushing = false;
      schedule();
    }
  };
  const handle = (data: string) => {
    let msg: SmeeMessage;
    try {
      msg = JSON.parse(data) as SmeeMessage;
    } catch {
      log("github relay: skipped a message that is not JSON");
      return;
    }
    const ev = relayEventOf(msg, secret, log);
    if (!ev) return;
    pending.push(ev);
    schedule();
  };

  const connect = async (attempt: number) => {
    let opened = false;
    try {
      const res = await doFetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      opened = true;
      log("github relay: connected to smee");
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        if (stopped) return;
        for (const data of parser.push(decoder.decode(chunk as Uint8Array, { stream: true })))
          handle(data);
      }
      if (!stopped) log("github relay: smee stream ended");
    } catch (e) {
      if (stopped) return;
      log(`github relay: smee connection failed: ${(e as Error).message}`);
    }
    if (stopped) return;
    const next = opened ? 0 : attempt;
    retryTimer = setTimeout(
      () => void connect(next + 1),
      backoffMs[Math.min(next, backoffMs.length - 1)],
    );
  };
  void connect(0);

  return {
    stop() {
      stopped = true;
      abort.abort();
      if (flushTimer) clearTimeout(flushTimer);
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}

/** `text/event-stream` framing: `push` returns the `data:` of every frame completed so far. */
export class SseParser {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const frames = this.buf.split("\n\n");
    this.buf = frames.pop() ?? "";
    const out: string[] = [];
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (data.length) out.push(data.join("\n"));
    }
    return out;
  }
}

/**
 * The relay's pass: `watchPrs` for terminal sessions (desktop ones are left to the
 * plugins), then always the broadcast, so plugins refresh even when the pass failed.
 */
export function relayHandler(deps: {
  watchPrs: (o: { desktop: boolean }) => Promise<{ lines: string[] }>;
  broadcast: (events: RelayEvent[]) => void;
  log: (line: string) => void;
}): (events: RelayEvent[]) => Promise<void> {
  return async (events) => {
    try {
      for (const l of (await deps.watchPrs({ desktop: false })).lines)
        deps.log(`github relay: ${l}`);
    } catch (e) {
      deps.log(`github relay: PR watch pass failed: ${(e as Error).message}`);
    }
    deps.broadcast(events);
  };
}

/**
 * `GET /api/github/events`: loopback-only SSE that harness plugins listen on. One
 * `data: {"events":[...],"at":<ms>}` frame per broadcast; a comment every 25 s keeps it open.
 */
export function createGithubEventsRouter(): {
  router: Router;
  broadcast(events: RelayEvent[]): void;
} {
  const subscribers = new Set<express.Response>();
  const router = express.Router();
  router.get("/api/github/events", localOnly, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": ok\n\n");
    subscribers.add(res);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
    req.on("close", () => {
      clearInterval(keepalive);
      subscribers.delete(res);
    });
  });
  return {
    router,
    broadcast(events) {
      const frame = `data: ${JSON.stringify({ events, at: Date.now() })}\n\n`;
      for (const res of subscribers) res.write(frame);
    },
  };
}

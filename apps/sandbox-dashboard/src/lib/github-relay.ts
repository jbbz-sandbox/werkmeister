/**
 * GitHub webhook relay over smee.io: a merged PR or a published release
 * triggers the same refresh the PR polls run, seconds after it happens. An
 * event is only a "refresh now" signal; nothing from its payload is kept.
 */

import crypto from "node:crypto";

export type RelayEvent = { event: "pull_request" | "release"; repo: string };

/** One smee message: GitHub's headers, lowercased, at the top level; the parsed JSON in `body`. */
export type SmeeMessage = Record<string, unknown> & { body?: unknown };

/** `x-hub-signature-256` is `sha256=<hex HMAC-SHA256 of body>`; false when missing or malformed. */
export function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(signature.slice("sha256=".length), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Only these trigger a pass: a PR closing (merged or not) and a release going out.
const ACTIONS: Record<RelayEvent["event"], string> = { pull_request: "closed", release: "published" };

/** The event a signed smee message carries, or null for a bad signature or an event that triggers nothing. */
export function relayEventOf(msg: SmeeMessage, secret: string): RelayEvent | null {
  const event = msg["x-github-event"];
  if (event !== "pull_request" && event !== "release") return null;
  const body = (msg.body ?? {}) as { action?: unknown; repository?: { full_name?: unknown } };
  if (body.action !== ACTIONS[event]) return null;
  // smee re-serializes the JSON it received; the signature is checked over that.
  const sig = msg["x-hub-signature-256"];
  if (!verifySignature(JSON.stringify(msg.body), typeof sig === "string" ? sig : undefined, secret))
    return null;
  return { event, repo: String(body.repository?.full_name ?? "") };
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

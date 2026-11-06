/**
 * Session-file helpers every adapter shares (SW-384): the transcript window, the
 * file tail and the workspace list's agent signal. An adapter supplies only how
 * its session lines parse.
 */
import fs from "node:fs/promises";
import { type AgentState, asksQuestion, questionOf, readAgentState } from "../agent_state.js";
import { turnStatus } from "./turn.js";
import type { SessionMessage, SessionSignal } from "./types.js";

/** Past this, a turn whose transcript ends mid-turn has died rather than gone quiet on a long tool call. */
const LIVE_TURN_MS = 10 * 60 * 1000;

/** The last *limit* user/assistant messages, with the tool rows that fall inside that window. */
export function windowMessages(entries: SessionMessage[], limit: number): SessionMessage[] {
  let start = entries.length;
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role !== "tool") {
      count++;
      if (count > limit) break;
    }
    start = i;
  }
  return entries.slice(start);
}

/** Read the last `maxBytes` of a file, dropping a leading partial line. Cheap enough
 *  to run per-workspace in the status sweep without reading whole transcripts. */
export async function readFileTail(file: string, maxBytes = 131072): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

/**
 * The workspace list's agent signal. A live turn this process runs is working;
 * otherwise the state file the workspace's hooks write (agent_state.ts) says what
 * the session last did. A workspace whose hooks predate it falls back to the
 * transcript tail: the agent spoke last → needs-you if it asked, else done; a
 * fresh tool row or user message → working; anything else → idle. The tail
 * can't see a permission prompt; only a hook can.
 */
export async function signalFrom(
  key: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
  parse: (text: string) => SessionMessage[],
): Promise<{ signal: SessionSignal; lastActivity: string | null }> {
  const lastActivity = src?.updatedAt ?? null;
  const state = turnStatus(key).state;
  const signal = (agent: AgentState, at = lastActivity, question: string | null = null) => ({
    signal: { state, agent, at, question },
    lastActivity,
  });
  if (state === "running") return signal("working");
  const recorded = readAgentState(dir);
  if (recorded) return signal(recorded.state, recorded.at, recorded.question ?? null);
  let last: SessionMessage | undefined;
  try {
    if (src?.sessionFile) last = parse(await readFileTail(src.sessionFile)).at(-1);
  } catch {
    /* best-effort — no signal */
  }
  if (!last || !lastActivity) return signal("idle");
  if (last.role === "assistant")
    return asksQuestion(last.text)
      ? signal("needs-you", lastActivity, questionOf(last.text))
      : signal("done");
  return signal(Date.now() - Date.parse(lastActivity) < LIVE_TURN_MS ? "working" : "idle");
}

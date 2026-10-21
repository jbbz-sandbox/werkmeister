/**
 * `sandbox hooks agent-state` — what a workspace's Claude session is doing (SW-46),
 * written by the Claude Code hooks hooks_gen.ts installs and read by
 * `getWorkspaceStatuses()`. The transcript can't carry it: "Claude spoke last"
 * is both a finished run and a question, and a permission prompt writes nothing.
 *
 * Builtins only and fail-open, like pr_guard.ts: PreToolUse runs it on every tool call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { dotDir } from "./dot_dir.js";
import { findRecordRoot } from "./pr_guard.js";

export type AgentState = "working" | "needs-you" | "done" | "idle";

/** `<dot-dir>/agent-state.json`. `at` is when `state` began, not the last hook. */
export interface AgentStateFile {
  state: AgentState;
  at: string;
  question?: string;
  /** Set when `question` is a Desktop wrap_up ask, which outlasts its turn's Stop. */
  via?: "wrap_up";
}

const STATES = new Set<AgentState>(["working", "needs-you", "done", "idle"]);
// Tools that block on the person even though PreToolUse fired for them.
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// Claude Desktop's end-of-turn box: its `ask` is the run's question, and the
// closing message after it is told not to repeat it.
const WRAP_UP = "mcp__ccd_turn__wrap_up";
// idle_prompt repeats a Stop that already happened; auth_success needs nothing.
const BLOCKING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

const stateFile = (root: string) => path.join(dotDir(root), "agent-state.json");

/** The recorded state, or null when there is none or it doesn't parse. */
export function readAgentState(root: string): AgentStateFile | null {
  try {
    const o = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    if (!STATES.has(o?.state) || typeof o.at !== "string") return null;
    const file: AgentStateFile = { state: o.state, at: o.at };
    if (typeof o.question === "string") file.question = o.question;
    if (o.via === "wrap_up") file.via = "wrap_up";
    return file;
  } catch {
    return null;
  }
}

/**
 * True when the message ends on a question mark, past closing markdown and quotes.
 * ponytail: trailing-`?` heuristic, so "Want X? Say so." reads as done; the
 * AskUserQuestion tool is the reliable signal when a run needs a real answer.
 */
export function asksQuestion(text: string): boolean {
  return /\?[\s*_`'")\]]*$/.test(text);
}

/** The message's last paragraph, which is where its question sits, capped for a card. */
export function questionOf(text: string): string {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1].trim().slice(0, 200);
}

/** The newest assistant text in a Claude Code transcript, from its last 64 KiB. */
function lastAssistantText(transcript: string): string | null {
  const fd = fs.openSync(transcript, "r");
  let text: string;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the cut-off first line, or a blank
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b) => b?.type === "text" && typeof b.text === "string");
    if (texts.length) return texts.map((b) => b.text).join("\n");
  }
  return null;
}

type Next = Omit<AgentStateFile, "at"> | null;

/** The state this hook event moves to, or null to leave the file as it is. */
export function nextState(input: Record<string, any>, current: AgentStateFile | null): Next {
  switch (input["hook_event_name"]) {
    case "UserPromptSubmit":
      return { state: "working" };
    case "PostToolUse":
      // wrap_up returns at once; its ask still waits on the person.
      return input["tool_name"] === WRAP_UP && current?.via === "wrap_up"
        ? null
        : { state: "working" };
    case "PreToolUse": {
      const tool = String(input["tool_name"] ?? "");
      const ask = input["tool_input"]?.["ask"];
      if (tool === WRAP_UP && typeof ask === "string" && ask.trim())
        return { state: "needs-you", question: ask.trim(), via: "wrap_up" };
      if (!ASKS.has(tool)) return { state: "working" };
      const asked = input["tool_input"]?.["questions"]?.[0]?.["question"];
      return {
        state: "needs-you",
        question: typeof asked === "string" ? asked : "Approve the plan?",
      };
    }
    case "Notification": {
      const type = input["notification_type"];
      const message = String(input["message"] ?? "");
      // Claude Code before notification_type sent only the message.
      const blocks =
        typeof type === "string"
          ? BLOCKING_NOTIFICATIONS.has(type)
          : !/waiting for your input/i.test(message);
      if (!blocks) return null;
      // The prompt to approve AskUserQuestion follows its PreToolUse: keep the real question.
      if (current?.state === "needs-you" && current.question) return null;
      return { state: "needs-you", question: message || undefined };
    }
    case "Stop": {
      let text: string | null = null;
      if (typeof input["last_assistant_message"] === "string")
        text = input["last_assistant_message"];
      else if (typeof input["transcript_path"] === "string")
        text = lastAssistantText(input["transcript_path"]);
      if (text && asksQuestion(text)) return { state: "needs-you", question: questionOf(text) };
      return current?.via === "wrap_up" ? null : { state: "done" };
    }
    case "SessionEnd":
      // A turn cut off by the exit is not live any more; done and needs-you still hold.
      return current?.state === "working" ? { state: "idle" } : null;
    default:
      return null;
  }
}

/** Apply one hook event to the workspace holding its cwd. Returns the file written, or null. */
export function record(input: Record<string, any>, now = new Date()): string | null {
  const root = findRecordRoot(String(input["cwd"] || process.cwd()));
  if (!root) return null;
  const current = readAgentState(root);
  const next = nextState(input, current);
  if (!next) return null;
  if (
    current &&
    current.state === next.state &&
    current.question === next.question &&
    current.via === next.via
  )
    return null;
  const body: AgentStateFile = { state: next.state, at: now.toISOString() };
  if (next.question) body.question = next.question;
  if (next.via) body.via = next.via;
  const file = stateFile(root);
  // Rename so the status sweep never reads half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Hook entrypoint: reads the event from stdin, prints nothing, always exits 0. */
export function main(): void {
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) record(parsed);
  } catch {
    // a hook must never break the session
  }
}

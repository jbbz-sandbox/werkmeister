/**
 * `werkmeister hooks agent-state` — what a workspace's Claude session is doing (SW-46),
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

/**
 * One open harness session, under `sessions.<session id>` in the same file (SW-182):
 * what idle-stop and the resume nudge read instead of Claude Code's own session files.
 * `at` is when `status` began.
 */
export interface SessionRecord {
  status: "busy" | "idle";
  at: string;
}

const stateFile = (root: string) => path.join(dotDir(root), "agent-state.json");

function readRaw(root: string): Record<string, any> | null {
  try {
    const o = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function stateOf(o: Record<string, any> | null): AgentStateFile | null {
  if (!STATES.has(o?.state) || typeof o?.at !== "string") return null;
  const file: AgentStateFile = { state: o.state, at: o.at };
  if (typeof o.question === "string") file.question = o.question;
  if (o.via === "wrap_up") file.via = "wrap_up";
  return file;
}

function sessionsOf(o: Record<string, any> | null): Record<string, SessionRecord> {
  const sessions: Record<string, SessionRecord> = {};
  for (const [id, s] of Object.entries(o?.sessions ?? {}) as [string, any][])
    if ((s?.status === "busy" || s?.status === "idle") && typeof s.at === "string")
      sessions[id] = { status: s.status, at: s.at };
  return sessions;
}

/** The recorded state, or null when there is none or it doesn't parse. */
export function readAgentState(root: string): AgentStateFile | null {
  return stateOf(readRaw(root));
}

/** The workspace's open sessions by id; empty when there are none or the file doesn't parse. */
export function readSessions(root: string): Record<string, SessionRecord> {
  return sessionsOf(readRaw(root));
}

// Claude Code's own busy/idle: busy from the prompt until Stop.
const BUSY_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);

/** The session's status after *event*: null removes it, undefined leaves it as it is. */
function nextSessionStatus(event: unknown): SessionRecord["status"] | null | undefined {
  if (event === "SessionEnd") return null;
  if (event === "SessionStart" || event === "Stop") return "idle";
  return BUSY_EVENTS.has(event as string) ? "busy" : undefined;
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

/** `<dot-dir>/paused.json` (SW-70). Its existence is the marker {@link pauseGate} checks. */
export interface PausedFile {
  at: string;
  /** The containers that were running at pause time, in dependency order. */
  containers: string[];
  /** The agent was mid-turn, so Resume tells the session to continue. */
  was_working: boolean;
}

export const PAUSED_REASON =
  "Workspace paused by the person from its card. End your turn now; it continues when they press Resume.";
export const RESUME_NUDGE = "Workspace resumed by the person. Continue where you left off.";

export const pausedPath = (root: string) => path.join(dotDir(root), "paused.json");
export const nudgePath = (root: string) => path.join(dotDir(root), "resume-nudge.json");

// Rename so a reader (the status sweep, the hook) never sees half a file.
function writeAtomic(file: string, body: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, file);
}

/** The pause record, or null when there is none or it doesn't parse. */
export function readPaused(root: string): PausedFile | null {
  try {
    const o = JSON.parse(fs.readFileSync(pausedPath(root), "utf8"));
    if (typeof o?.at !== "string" || !Array.isArray(o.containers)) return null;
    return { at: o.at, containers: o.containers.map(String), was_working: o.was_working === true };
  } catch {
    return null;
  }
}

export function writePaused(root: string, p: PausedFile): void {
  writeAtomic(pausedPath(root), p);
}

export function clearPaused(root: string): void {
  fs.rmSync(pausedPath(root), { force: true });
}

/** The pending "continue" for a live session, left by Resume for the pane to deliver. */
export function readNudge(root: string): string | null {
  try {
    const o = JSON.parse(fs.readFileSync(nudgePath(root), "utf8"));
    return typeof o?.message === "string" ? o.message : null;
  } catch {
    return null;
  }
}

export function writeNudge(root: string, message: string, now = new Date()): void {
  writeAtomic(nudgePath(root), { message, at: now.toISOString() });
}

/** Read and remove the pending nudge, so only one deliverer sends it. */
export function claimNudge(root: string): string | null {
  const message = readNudge(root);
  fs.rmSync(nudgePath(root), { force: true });
  return message;
}

/**
 * The hook's stdout while the workspace is paused, or null. `continue: false` ends
 * the turn with the transcript intact; the deny also holds where a host ignores it.
 */
export function pauseGate(input: Record<string, any>, root: string): object | null {
  if (!fs.existsSync(pausedPath(root))) return null;
  switch (input["hook_event_name"]) {
    case "PreToolUse":
      return {
        continue: false,
        stopReason: PAUSED_REASON,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: PAUSED_REASON,
        },
      };
    case "UserPromptSubmit":
      // One guard for every sender: the person, claude-send, PR callbacks, check-in.
      return {
        decision: "block",
        reason: "This workspace is paused. Press ▶ Resume on its card first.",
      };
    default:
      return null;
  }
}

/** Apply one hook event to the workspace holding its cwd. Returns the file written, or null. */
export function record(input: Record<string, any>, now = new Date()): string | null {
  const root = findRecordRoot(String(input["cwd"] || process.cwd()));
  if (!root) return null;
  const raw = readRaw(root);
  const current = stateOf(raw);
  const next = nextState(input, current);
  const stateChanged =
    next !== null &&
    !(
      current &&
      current.state === next.state &&
      current.question === next.question &&
      current.via === next.via
    );

  const sessions = sessionsOf(raw);
  const id = input["session_id"];
  const status =
    typeof id === "string" && id ? nextSessionStatus(input["hook_event_name"]) : undefined;
  let sessionsChanged = false;
  if (status === null && id in sessions) {
    delete sessions[id];
    sessionsChanged = true;
  } else if (status && sessions[id]?.status !== status) {
    sessions[id] = { status, at: now.toISOString() };
    sessionsChanged = true;
  }
  if (!stateChanged && !sessionsChanged) return null;

  let body: Partial<AgentStateFile> & { sessions?: Record<string, SessionRecord> } = {
    ...current,
  };
  if (stateChanged && next) {
    body = { state: next.state, at: now.toISOString() };
    if (next.question) body.question = next.question;
    if (next.via) body.via = next.via;
  }
  if (Object.keys(sessions).length) body.sessions = sessions;
  // ponytail: read-modify-write with no lock, so two sessions' hooks in the same
  // millisecond can drop one's change; a file lock if that shows up.
  const file = stateFile(root);
  writeAtomic(file, body);
  return file;
}

/**
 * Hook entrypoint: reads the event from stdin and always exits 0. Prints only the
 * pause gate; a blocked event records nothing, so it can't read as `working`.
 */
export function main(): void {
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const root = findRecordRoot(String(parsed["cwd"] || process.cwd()));
    const gate = root ? pauseGate(parsed, root) : null;
    if (gate) {
      console.log(JSON.stringify(gate));
      return;
    }
    // The session got a prompt, so a "continue" still waiting for it is stale.
    if (root && parsed["hook_event_name"] === "UserPromptSubmit")
      fs.rmSync(nudgePath(root), { force: true });
    record(parsed);
  } catch {
    // a hook must never break the session
  }
}

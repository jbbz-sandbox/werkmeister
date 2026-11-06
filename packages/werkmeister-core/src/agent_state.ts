/**
 * `werkmeister internal agent-state` — what a workspace's Claude session is doing (SW-46),
 * written by the Claude Code hooks hooks_gen.ts installs and read by
 * `getWorkspaceStatuses()`. The transcript can't carry it: "Claude spoke last"
 * is both a finished run and a question, and a permission prompt writes nothing.
 *
 * Builtins only and fail-open, like pr_guard.ts: PreToolUse runs it on every tool call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { dotDir } from "./dot_dir.js";
import { WRAP_UP } from "./harness/claude/desktop.js";
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
  /** Written by a `claude -p` turn, which may only end its own record (SW-397). */
  headless?: true;
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
      sessions[id] = { status: s.status, at: s.at, ...(s.headless === true && { headless: true }) };
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
    case "PermissionRequest": {
      // Codex's approval prompt; it has no Notification event (SW-189).
      const described = input["tool_input"]?.["description"];
      return {
        state: "needs-you",
        question:
          typeof described === "string" && described.trim()
            ? described.trim()
            : `Approve ${String(input["tool_name"] ?? "the tool call")}?`,
      };
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
/** `<dot-dir>/waiting.json` (SW-181): the feature is queued for capacity; {@link pauseGate} holds the session. */
export const waitingPath = (root: string) => path.join(dotDir(root), "waiting.json");

// Rename so a reader (the status sweep, the hook) never sees half a file.
export function writeAtomic(file: string, body: unknown): void {
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

export interface WaitingFile {
  position: number;
  reason: string;
}

/** The waiting record, or null when there is none or it doesn't parse. */
export function readWaiting(root: string): WaitingFile | null {
  try {
    const o = JSON.parse(fs.readFileSync(waitingPath(root), "utf8"));
    if (!Number.isInteger(o?.position)) return null;
    return { position: o.position, reason: String(o.reason ?? "") };
  } catch {
    return null;
  }
}

export function writeWaiting(root: string, w: WaitingFile): void {
  writeAtomic(waitingPath(root), w);
}

export function clearWaiting(root: string): void {
  fs.rmSync(waitingPath(root), { force: true });
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

/** Set `needs-you` with *question*, keeping the session records; the session's next hook event replaces it. */
export function flagNeedsYou(root: string, question: string, now = new Date()): void {
  const raw = readRaw(root);
  if (stateOf(raw)?.question === question) return;
  writeAtomic(stateFile(root), {
    ...raw,
    state: "needs-you",
    at: now.toISOString(),
    question,
    via: undefined,
  });
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

/** `<dot-dir>/wake-nudge-<session>.json` (SW-418): a `pr watch` wake held for that open session. */
export const wakeNudgePath = (root: string, session: string) =>
  path.join(dotDir(root), `wake-nudge-${session}.json`);
// The id comes from hook input and names a file.
const SESSION_ID = /^[\w-]+$/;

function readWakeNudge(file: string): string | null {
  try {
    const message = JSON.parse(fs.readFileSync(file, "utf8"))?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

const pendingWake = (root: string, session: unknown) =>
  typeof session === "string" &&
  SESSION_ID.test(session) &&
  fs.existsSync(wakeNudgePath(root, session));

/**
 * Each session with a held wake in *root* and when its file last changed, for the band to prompt when
 * idle (SW-463); `at` tells a new wake from one already prompted for.
 */
export function heldWakes(root: string): { session: string; at: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dotDir(root));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const session = n.match(/^wake-nudge-(.+)\.json$/)?.[1];
    if (!session || !SESSION_ID.test(session)) return [];
    try {
      return [{ session, at: fs.statSync(wakeNudgePath(root, session)).mtime.toISOString() }];
    } catch {
      return []; // claimed since the listing
    }
  });
}

/** Queue *message* for *session*'s next hook event, after any it hasn't had yet. */
export function writeWakeNudge(root: string, session: string, message: string, now = new Date()) {
  if (!SESSION_ID.test(session)) return;
  const file = wakeNudgePath(root, session);
  const before = readWakeNudge(file);
  writeAtomic(file, {
    message: before ? `${before}\n\n${message}` : message,
    at: now.toISOString(),
  });
}

/**
 * The hook's stdout handing *input*'s session its pending wake, or null. Claimed by renaming
 * the file first (SW-444): a rename succeeds once, so parallel hooks deliver it once, and a
 * `pr watch` write after it starts a new file instead of being dropped. Stop is blocked so a
 * turn that is ending still reads it.
 */
export function deliverWake(input: Record<string, any>, root: string): object | null {
  const event = input["hook_event_name"];
  if (event !== "UserPromptSubmit" && event !== "PostToolUse" && event !== "Stop") return null;
  // A subagent's hooks carry the parent's session id plus agent_id (seen live, Claude Code 2.1.318,
  // SW-443); its context isn't the conversation's.
  if (input["agent_id"]) return null;
  if (!pendingWake(root, input["session_id"])) return null;
  const file = wakeNudgePath(root, input["session_id"]);
  const claimed = `${file}.${process.pid}-${Date.now()}.claimed`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return null; // another hook claimed it
  }
  const message = readWakeNudge(claimed);
  fs.rmSync(claimed, { force: true });
  if (message === null) return null;
  return event === "Stop"
    ? { decision: "block", reason: message }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: message } };
}

/**
 * The hook's stdout while the workspace is paused or waiting for capacity, or null. `continue: false` ends
 * the turn with the transcript intact; the deny also holds where a host ignores it.
 */
export function pauseGate(input: Record<string, any>, root: string): object | null {
  // Paused wins: Resume, not a grant, is what the person is waiting to press.
  const paused = fs.existsSync(pausedPath(root));
  const waiting = paused ? null : readWaiting(root);
  if (!paused && !waiting) return null;
  const reason = waiting
    ? `Waiting for capacity (position ${waiting.position}). End your turn now; it starts when another feature stops.`
    : PAUSED_REASON;
  switch (input["hook_event_name"]) {
    case "PreToolUse": {
      const deny = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      // Codex fails a PreToolUse hook whose output has continue/stopReason, and the tool then runs.
      if (process.env.WERKMEISTER_HOOK_HARNESS === "codex") return deny;
      return { continue: false, stopReason: reason, ...deny };
    }
    case "UserPromptSubmit":
      // One guard for every sender: the person, claude-send, PR callbacks, check-in.
      return {
        decision: "block",
        reason: waiting
          ? "This workspace is waiting for capacity; it starts on its own."
          : "This workspace is paused. Press ▶ Resume on its card first.",
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
  let next = nextState(input, current);
  // A held PR wake's needs-you lasts until the session is handed it, not its next tool call (SW-418).
  if (
    next?.state === "working" &&
    current?.state === "needs-you" &&
    pendingWake(root, input["session_id"])
  )
    next = null;
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
  const headless = process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk") ?? false;
  // `claude -p --resume <id>` shares an open session's id: its busy/idle counts, its end must not end that session.
  // shortcut: an interactive session that dies without SessionEnd stays here until stale (24 h); upgrade if crashed sessions block Resume.
  const foreign = headless && sessions[id] && !sessions[id].headless;
  const mark = headless && !foreign;
  const status =
    typeof id === "string" && id ? nextSessionStatus(input["hook_event_name"]) : undefined;
  let sessionsChanged = false;
  if (status === null && id in sessions && !foreign) {
    delete sessions[id];
    sessionsChanged = true;
  } else if (status && (sessions[id]?.status !== status || !!sessions[id]?.headless !== mark)) {
    sessions[id] = { status, at: now.toISOString(), ...(mark && { headless: true as const }) };
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
    const wake = root ? deliverWake(parsed, root) : null;
    if (wake) console.log(JSON.stringify(wake));
    // A blocked Stop isn't the end of the turn, so it records nothing, like the pause gate.
    if (wake && parsed["hook_event_name"] === "Stop") return;
    record(parsed);
  } catch {
    // a hook must never break the session
  }
}

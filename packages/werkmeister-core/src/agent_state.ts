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

// Tools that block on the person even though PreToolUse fired for them.
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// idle_prompt repeats a Stop that already happened; auth_success needs nothing.
const BLOCKING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

/** What one session is waiting on the person for. `source: "text"` is the reply-text guess. */
export interface SessionAsk {
  kind: "question" | "permission" | "plan";
  what: string;
  at: string;
  source: "session" | "text";
  /** A Desktop wrap_up ask, which outlasts its turn's Stop. */
  via?: "wrap_up";
}

/**
 * One harness session, in its own `<dot-dir>/sessions/<id>.json` (SW-487) so no two sessions
 * share a file: one can't overwrite another's ask, and no lock is needed. `at` is when `status`
 * began (SW-182); `last` is the newest hook event, for telling a crashed session from a quiet one.
 */
export interface SessionRecord {
  status: "busy" | "idle";
  at: string;
  /** Written by a `claude -p` turn, which may only end its own record (SW-397). */
  headless?: true;
  last?: string;
  /** The open tool call; `command` is a Bash command's first 200 characters. */
  tool?: { name: string; command?: string; at: string };
  /** Subagents started and not yet stopped. */
  subagents?: number;
  ask?: SessionAsk;
  /** The last turn reached Stop, so the session is done rather than never started. */
  stopped?: true;
}

/** Past this with no hook event, a busy session has crashed or been killed (SW-487 Q7). */
export const SESSION_GONE_MS = 30 * 60_000;

// The id comes from hook input and names a file.
const SESSION_ID = /^[\w-]+$/;
const legacyFile = (root: string) => path.join(dotDir(root), "agent-state.json");
export const sessionsDir = (root: string) => path.join(dotDir(root), "sessions");
const sessionPath = (root: string, id: string) => path.join(sessionsDir(root), `${id}.json`);

function readJson(file: string): Record<string, any> | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function sessionOf(s: any): SessionRecord | null {
  if ((s?.status !== "busy" && s?.status !== "idle") || typeof s.at !== "string") return null;
  const r: SessionRecord = { status: s.status, at: s.at };
  if (s.headless === true) r.headless = true;
  if (typeof s.last === "string") r.last = s.last;
  if (typeof s.tool?.name === "string" && typeof s.tool.at === "string") r.tool = s.tool;
  if (Number.isInteger(s.subagents) && s.subagents > 0) r.subagents = s.subagents;
  if (typeof s.ask?.what === "string" && typeof s.ask.at === "string") r.ask = s.ask;
  if (s.stopped === true) r.stopped = true;
  return r;
}

/**
 * The workspace's sessions by id; empty when there are none.
 * shortcut: also reads the pre-SW-487 `agent-state.json` `sessions{}` for ids with no file of their
 * own, so a session open across the upgrade still counts as live; drop with the VS Code/dashboard migration.
 */
export function readSessions(root: string): Record<string, SessionRecord> {
  const out: Record<string, SessionRecord> = {};
  for (const [id, s] of Object.entries(readJson(legacyFile(root))?.["sessions"] ?? {})) {
    const r = sessionOf(s);
    if (r) out[id] = r;
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir(root));
  } catch {
    /* no sessions yet */
  }
  for (const n of names) {
    const id = n.match(/^([\w-]+)\.json$/)?.[1];
    const r = id ? sessionOf(readJson(path.join(sessionsDir(root), n))) : null;
    if (id && r) out[id] = r;
  }
  return out;
}

const lastOf = (s: SessionRecord) => Date.parse(s.last ?? s.at);
export const sessionGone = (s: SessionRecord, now = Date.now()) =>
  s.status === "busy" && now - lastOf(s) >= SESSION_GONE_MS;

/**
 * The one-word badge older readers show (VS Code, the dashboard, preemption), from the session
 * records alone; null when no session has done anything yet, so the caller falls back to the transcript.
 */
export function agentOf(
  sessions: Record<string, SessionRecord>,
  now = Date.now(),
): { agent: AgentState; at: string; question: string | null } | null {
  const list = Object.values(sessions);
  const ask = list
    .flatMap((s) => (s.ask ? [s.ask] : []))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  if (ask) return { agent: "needs-you", at: ask.at, question: ask.what };
  const busy = list.find((s) => s.status === "busy" && !sessionGone(s, now));
  if (busy) return { agent: "working", at: busy.at, question: null };
  const newest = list.sort((a, b) => lastOf(b) - lastOf(a))[0];
  if (!newest) return null;
  if (newest.stopped) return { agent: "done", at: newest.at, question: null };
  return newest.status === "busy" ? { agent: "idle", at: newest.at, question: null } : null;
}

/**
 * True when the message's last paragraph holds a sentence ending in a question mark, so
 * "Want X? Say so." asks. shortcut: a rhetorical closing `?` still reads as a question; it is
 * shown as a guess, and AskUserQuestion is the reliable signal.
 */
export function asksQuestion(text: string): boolean {
  return /\?(?=[\s*_`'")\]]|$)/.test(questionOf(text));
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

/** A permission prompt for an AskUserQuestion or ExitPlanMode call is that question, not news. */
const askingTool = (s: SessionRecord) =>
  s.ask?.kind !== "permission" && s.tool !== undefined && ASKS.has(s.tool.name);

/**
 * The session's record after this hook event: null removes it, undefined leaves it as it is.
 * *foreign* is a headless turn on an interactive session's id, which counts for busy/idle only.
 */
export function nextSession(
  input: Record<string, any>,
  current: SessionRecord | null,
  now: Date,
  opts: { headless?: boolean; foreign?: boolean } = {},
): SessionRecord | null | undefined {
  const event = input["hook_event_name"];
  const at = now.toISOString();
  const s: SessionRecord = current ? { ...current } : { status: "idle", at };
  if (!opts.foreign) {
    if (opts.headless) s.headless = true;
    else delete s.headless;
  }
  s.last = at;
  const status = (to: SessionRecord["status"]) => {
    if (s.status !== to) Object.assign(s, { status: to, at });
  };
  // Subagent hooks carry the parent's session id plus agent_id (SW-443): never the parent's state.
  if (event === "SubagentStart" || event === "SubagentStop") {
    const n = (s.subagents ?? 0) + (event === "SubagentStart" ? 1 : -1);
    if (n > 0) s.subagents = n;
    else delete s.subagents;
    return s;
  }
  if (input["agent_id"]) return current ? s : undefined;
  const tool = String(input["tool_name"] ?? "");
  const turnOnly = opts.foreign; // its prompt and tools belong to the fork, not the open session
  switch (event) {
    case "SessionStart":
      status("idle");
      // A new or resumed session has no subagents yet; a missed SubagentStop must not stick.
      if (!turnOnly) for (const k of ["tool", "ask", "stopped", "subagents"] as const) delete s[k];
      return s;
    case "UserPromptSubmit":
      status("busy");
      if (!turnOnly) for (const k of ["tool", "ask", "stopped"] as const) delete s[k];
      return s;
    case "PreToolUse": {
      status("busy");
      if (turnOnly) return s;
      delete s.stopped;
      const command = input["tool_input"]?.["command"];
      s.tool = {
        name: tool,
        ...(typeof command === "string" && { command: command.slice(0, 200) }),
        at,
      };
      const wrapAsk = input["tool_input"]?.["ask"];
      if (tool === WRAP_UP && typeof wrapAsk === "string" && wrapAsk.trim())
        s.ask = { kind: "question", what: wrapAsk.trim(), at, source: "session", via: "wrap_up" };
      else if (tool === "AskUserQuestion") {
        const q = input["tool_input"]?.["questions"]?.[0]?.["question"];
        s.ask = {
          kind: "question",
          what: typeof q === "string" ? q : "Answer the question",
          at,
          source: "session",
        };
      } else if (tool === "ExitPlanMode")
        s.ask = { kind: "plan", what: "Approve the plan?", at, source: "session" };
      else delete s.ask;
      return s;
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      status("busy");
      if (turnOnly) return s;
      delete s.tool;
      // wrap_up returns at once; its ask still waits on the person.
      if (!(tool === WRAP_UP && s.ask?.via === "wrap_up")) delete s.ask;
      return s;
    case "Notification": {
      const type = input["notification_type"];
      const message = String(input["message"] ?? "");
      // Claude Code before notification_type sent only the message.
      const blocks =
        typeof type === "string"
          ? BLOCKING_NOTIFICATIONS.has(type)
          : !/waiting for your input/i.test(message);
      if (!blocks || turnOnly || askingTool(s) || s.ask?.kind === "permission") return undefined;
      s.ask = {
        kind: type === "elicitation_dialog" ? "question" : "permission",
        what: message || "Approve the tool call?",
        at,
        source: "session",
      };
      return s;
    }
    case "PermissionRequest": {
      // Claude Code's and Codex's approval prompt; Notification may also fire for it (deduped here).
      if (turnOnly || askingTool(s) || s.ask?.kind === "permission") return undefined;
      const described = input["tool_input"]?.["description"];
      s.ask = {
        kind: "permission",
        what:
          typeof described === "string" && described.trim()
            ? described.trim()
            : `Approve ${tool || "the tool call"}?`,
        at,
        source: "session",
      };
      return s;
    }
    case "PermissionDenied":
      if (s.ask?.kind === "permission") delete s.ask;
      return s;
    case "Stop":
    case "StopFailure": {
      status("idle");
      if (turnOnly) return s;
      delete s.tool;
      s.stopped = true;
      let text: string | null = null;
      if (typeof input["last_assistant_message"] === "string")
        text = input["last_assistant_message"];
      else if (typeof input["transcript_path"] === "string")
        text = lastAssistantText(input["transcript_path"]);
      if (text && asksQuestion(text))
        s.ask = { kind: "question", what: questionOf(text), at, source: "text" };
      else if (s.ask?.via !== "wrap_up") delete s.ask;
      return s;
    }
    case "SessionEnd":
      return opts.foreign ? s : null;
    default:
      return undefined;
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
  /** A service start blocked on capacity (SW-540): its own poll admits it, not the grant. */
  services?: string[];
}

/** The waiting record, or null when there is none or it doesn't parse. */
export function readWaiting(root: string): WaitingFile | null {
  try {
    const o = JSON.parse(fs.readFileSync(waitingPath(root), "utf8"));
    if (!Number.isInteger(o?.position)) return null;
    return {
      position: o.position,
      reason: String(o.reason ?? ""),
      ...(Array.isArray(o.services) ? { services: o.services.map(String) } : {}),
    };
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

export function writeNudge(root: string, message: string, now = new Date()): void {
  writeAtomic(nudgePath(root), { message, at: now.toISOString() });
}

/** Read and remove the pending nudge, so only one deliverer sends it. */
export function claimNudge(root: string): string | null {
  const message = readNudge(root);
  fs.rmSync(nudgePath(root), { force: true });
  return message;
}

/** A system notice for the card, apart from any session's ask (SW-487): only its resolver or the person clears it. */
export interface Notice {
  what: string;
  action: string;
  at: string;
  url?: string;
}

const noticesPath = (root: string) => path.join(dotDir(root), "notices.json");

export function readNotices(root: string): Record<string, Notice> {
  const out: Record<string, Notice> = {};
  for (const [id, n] of Object.entries(readJson(noticesPath(root)) ?? {}) as [string, any][])
    if (typeof n?.what === "string" && typeof n.at === "string")
      out[id] = {
        what: n.what,
        action: String(n.action ?? ""),
        at: n.at,
        ...(n.url && { url: String(n.url) }),
      };
  return out;
}

// shortcut: read-modify-write; pr watch writes under its lock, but a dismiss from the pane can race it. Lock if a notice is lost.
export function raiseNotice(
  root: string,
  id: string,
  n: Omit<Notice, "at">,
  now = new Date(),
): void {
  const all = readNotices(root);
  if (all[id]?.what === n.what) return;
  writeAtomic(noticesPath(root), { ...all, [id]: { ...n, at: now.toISOString() } });
}

export function clearNotice(root: string, id: string): void {
  const all = readNotices(root);
  if (!(id in all)) return;
  delete all[id];
  writeAtomic(noticesPath(root), all);
}

/** `<dot-dir>/wake-nudge-<session>.json` (SW-418): a `pr watch` wake held for that open session. */
export const wakeNudgePath = (root: string, session: string) =>
  path.join(dotDir(root), `wake-nudge-${session}.json`);
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
  // Claimed like deliverWake does (SW-475): a hook firing meanwhile finds no file, so it can't
  // deliver what this write puts back. Writers are serialized by the pr-watch lock.
  const claimed = `${file}.${process.pid}-${now.getTime()}.claimed`;
  let before: string | null = null;
  try {
    fs.renameSync(file, claimed);
    before = readWakeNudge(claimed);
  } catch {
    /* nothing held */
  }
  try {
    writeAtomic(file, {
      message: before ? `${before}\n\n${message}` : message,
      at: now.toISOString(),
    });
  } catch (e) {
    // Put the held wake back (SW-502) so pendingWake and deliverWake still find it.
    if (before !== null) fs.renameSync(claimed, file);
    throw e;
  }
  fs.rmSync(claimed, { force: true });
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
  // A service start's wait (SW-540) is this session's own job: the person must be able to prompt it
  // and it must be able to run the tool that stops the wait (SW-545). Only a whole-feature queue holds it.
  if (waiting?.services) return null;
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

/**
 * Context for a UserPromptSubmit while this session's own service start waits for capacity (SW-540), else
 * null. Not a gate (SW-545): the prompt goes on to be recorded, so the session still reads as working.
 */
export function serviceWaitContext(input: Record<string, any>, root: string): string | null {
  if (input["hook_event_name"] !== "UserPromptSubmit") return null;
  const waiting = readWaiting(root);
  if (!waiting?.services) return null;
  // The poll rewrites the file every 15 s; a killed one leaves it behind (no finally on SIGTERM), and the
  // scheduler drops such a waiter after 60 s, so an older file is a dead wait, not a live one.
  if (Date.now() - fs.statSync(waitingPath(root)).mtimeMs > 60_000) return null;
  return (
    `This session's own service start is waiting for capacity (position ${waiting.position}): ` +
    `${waiting.services.join(", ")}. The werkmeister command that started it (pr gate, pr open or ` +
    "feature up --service), usually a background job in this session, polls every 15 s for up to " +
    "10 min and goes on by itself when room frees. To stop the wait, stop that job (TaskStop, or kill " +
    "its pid; never pkill)."
  );
}

/** *wake*'s UserPromptSubmit output with *context* in front: the hook prints one JSON object. */
function withContext(wake: object | null, context: string): object {
  const prior = (wake as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput?.additionalContext;
  const additionalContext = prior ? `${context}\n\n${prior}` : context;
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

/** Apply one hook event to its session's record in the workspace holding its cwd. Returns the file written, or null. */
export function record(input: Record<string, any>, now = new Date()): string | null {
  const root = findRecordRoot(String(input["cwd"] || process.cwd()));
  const id = input["session_id"];
  if (!root || typeof id !== "string" || !SESSION_ID.test(id)) return null;
  const file = sessionPath(root, id);
  const own = sessionOf(readJson(file));
  const legacy = readJson(legacyFile(root));
  const current = own ?? sessionOf(legacy?.["sessions"]?.[id]);
  const headless = process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk") ?? false;
  // `claude -p --resume <id>` shares an open session's id: its busy/idle counts, its end must not end that session.
  const foreign = headless && current !== null && !current.headless;
  const next = nextSession(input, current, now, { headless, foreign });
  if (next === undefined) return null;
  // A session open across the upgrade moves out of the old file on its first event, so it can't reappear after it ends.
  if (legacy?.["sessions"]?.[id]) {
    delete legacy["sessions"][id];
    writeAtomic(legacyFile(root), legacy);
  }
  if (next === null) {
    if (!current) return null;
    fs.rmSync(file, { force: true });
    return file;
  }
  // shortcut: parallel tool calls in one session still race on its own file (the last `tool` wins);
  // both are busy and none carries an ask, which only blocking tools and prompts set.
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  writeAtomic(file, next);
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
    const wait = root ? serviceWaitContext(parsed, root) : null;
    if (wait) console.log(JSON.stringify(withContext(wake, wait)));
    else if (wake) console.log(JSON.stringify(wake));
    // A blocked Stop isn't the end of the turn, so it records nothing, like the pause gate.
    if (wake && parsed["hook_event_name"] === "Stop") return;
    record(parsed);
  } catch {
    // a hook must never break the session
  }
}

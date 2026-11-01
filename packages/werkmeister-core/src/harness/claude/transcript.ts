/**
 * Claude Code sessions on disk (SW-187: the Claude harness's transcript reader).
 *
 * Claude Code stores one JSONL transcript per session under
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, where <encoded-cwd> is
 * the workspace path with non-alphanumeric characters replaced by "-". The
 * newest .jsonl in a workspace's project dir is its "last opened" session.
 *
 * Every function here takes a resolved folder; sandbox.ts maps workspace names to it.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WorkspaceError } from "../../errors.js";
import { isFile } from "../../tool_bins.js";

export interface ClaudeMessage {
  /** "tool" entries are compact activity rows ("Bash: npm test") from tool_use blocks. */
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp: string | null;
}

export interface ClaudeTranscript {
  /** Session ID (JSONL filename stem) of the newest session, or null if none. */
  sessionId: string | null;
  workspacePath: string;
  /** Last N user/assistant text messages, oldest first. */
  messages: ClaudeMessage[];
  /** Total sessions found for this workspace. */
  sessionCount: number;
  /** mtime of the newest session file (ISO), or null. */
  updatedAt: string | null;
}

/**
 * Normalize a path the way Claude Code encodes project dirs: every character
 * that isn't [a-zA-Z0-9] becomes "-". Comparing encode(dirName) with
 * encode(workspacePath) is robust even if the exact substitution set differs,
 * because "-" maps to itself.
 */
function encodeClaudeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Find the Claude Code project dir for a workspace path, or null. */
export async function findClaudeProjectDir(workspacePath: string): Promise<string | null> {
  const root = path.join(os.homedir(), ".claude", "projects");
  const want = encodeClaudeProjectDir(workspacePath);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory() && encodeClaudeProjectDir(e.name) === want) {
      return path.join(root, e.name);
    }
  }
  return null;
}

/** List a project dir's session files, newest mtime first. */
export async function listSessionFiles(
  projectDir: string,
): Promise<Array<{ file: string; mtime: Date }>> {
  let names: string[];
  try {
    names = await fs.readdir(projectDir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; mtime: Date }> = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    try {
      const st = await fs.stat(path.join(projectDir, n));
      out.push({ file: path.join(projectDir, n), mtime: st.mtime });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Pick the session file for an optional pinned id, else the newest. */
function pickSession<T extends { file: string }>(sessions: T[], sessionId?: string): T | null {
  if (!sessions.length) return null;
  if (sessionId) {
    const match = sessions.find((s) => path.basename(s.file, ".jsonl") === sessionId);
    if (match) return match; // else fall through to newest (stale/gone id)
  }
  return sessions[0];
}

/**
 * A human label for a session file: the Claude-written `ai-title` line, else
 * the first user message, else the id's first 8 chars. The `ai-title` sits a
 * dozen lines in but *after* possibly-huge attachment lines, so scan lines
 * (bounded) rather than a byte prefix, and stop as soon as it's found.
 */
export async function readSessionTitle(file: string, sessionId: string): Promise<string> {
  let firstUser = "";
  let scanned = 0;
  try {
    const rl = readline.createInterface({
      input: createReadStream(file, "utf-8"),
      crlfDelay: Infinity,
    });
    for await (const raw of rl) {
      if (!raw.trim() || scanned++ > 60) break;
      let e: { type?: string; aiTitle?: string; message?: { role?: string; content?: unknown } };
      try {
        e = JSON.parse(raw);
      } catch {
        continue;
      }
      if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim()) {
        rl.close();
        return e.aiTitle.trim().slice(0, 80);
      }
      if (!firstUser && e.type === "user" && e.message?.role === "user") {
        firstUser = cleanMessageText(extractMessageText(e.message.content)).replace(/\s+/g, " ");
      }
    }
    rl.close();
  } catch {
    /* unreadable → fall through to fallbacks */
  }
  return firstUser ? firstUser.slice(0, 80) : sessionId.slice(0, 8);
}

/**
 * List a workspace's Claude sessions (newest first) with a display title, for
 * the chat panel's session picker. N is small (one workspace's sessions), so a
 * bounded per-file title scan is fine.
 */
export async function listSessionsIn(
  target: string,
): Promise<Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>> {
  const projectDir = await findClaudeProjectDir(target);
  if (!projectDir) return [];
  const files = await listSessionFiles(projectDir);
  return Promise.all(
    files.map(async (f, i) => {
      const sessionId = path.basename(f.file, ".jsonl");
      return {
        sessionId,
        title: await readSessionTitle(f.file, sessionId),
        updatedAt: f.mtime.toISOString(),
        isNewest: i === 0,
      };
    }),
  );
}

/** Pull displayable text out of a transcript line's message content. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: string }).text;
      if (typeof t === "string" && t.trim()) parts.push(t.trim());
    }
  }
  return parts.join("\n\n");
}

/**
 * One-line summary of a tool_use input for activity rows — the first
 * meaningful string field (command, path, pattern, …), whitespace-collapsed
 * and truncated. Mirrors how vibe-kanban normalizes agent tool calls.
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const preferred = [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
    "name",
    "message",
  ];
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 100);
  }
  const first = Object.values(obj).find((v) => typeof v === "string" && (v as string).trim());
  return typeof first === "string" ? first.trim().replace(/\s+/g, " ").slice(0, 100) : "";
}

/** Strip host-injected tag blocks; returns "" if nothing user-authored remains. */
function cleanMessageText(text: string): string {
  const cleaned = text
    .replace(/<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned || cleaned.startsWith("[Request interrupted")) return "";
  return cleaned;
}

/**
 * Normalize a Claude Code session JSONL (full file text) into ordered
 * {role, text, timestamp} entries: text blocks → messages, tool_use blocks →
 * compact activity rows. The single normalizer shared by the transcript tool
 * (which then windows) and the live tailer (lib/session-stream.ts, which
 * index-addresses each entry). Positions are stable append-only, so an entry's
 * index is its identity for incremental streaming.
 */
export function parseSessionLines(text: string): ClaudeMessage[] {
  const entries: ClaudeMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      isMeta?: boolean;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isMeta) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const role = entry.message?.role;
    const ts = entry.timestamp ?? null;
    const content = entry.message?.content;

    if (role === "user") {
      const body = cleanMessageText(extractMessageText(content));
      if (body) entries.push({ role: "user", text: body, timestamp: ts });
      continue;
    }
    if (role !== "assistant") continue;

    // Assistant lines: emit text blocks as messages and tool_use blocks as
    // compact activity rows, preserving their in-turn order.
    if (typeof content === "string") {
      const body = cleanMessageText(content);
      if (body) entries.push({ role: "assistant", text: body, timestamp: ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        const body = cleanMessageText(b.text);
        if (body) entries.push({ role: "assistant", text: body, timestamp: ts });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        const detail = summarizeToolInput(b.input);
        entries.push({
          role: "tool",
          text: detail ? `${b.name}: ${detail}` : b.name,
          timestamp: ts,
        });
      }
    }
  }
  return entries;
}

/**
 * Locate the newest Claude Code session file for a workspace (the source the
 * live tailer watches). Mirrors {@link transcriptIn}'s file resolution
 * but returns the file path + session metadata instead of parsed messages.
 */
export async function sessionSourceIn(
  target: string,
  sessionId?: string,
  startDir?: string,
): Promise<{
  workspacePath: string;
  projectDir: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  sessionCount: number;
  updatedAt: string | null;
}> {
  // Claude Code files sessions by the folder they started in, which may be below the workspace.
  const projectDir = await findClaudeProjectDir(startDir ?? target);
  const none = {
    workspacePath: target,
    projectDir,
    sessionFile: null,
    sessionId: null,
    sessionCount: 0,
    updatedAt: null,
  };
  if (!projectDir) return { ...none, projectDir: null };
  const sessions = await listSessionFiles(projectDir);
  const chosen = pickSession(sessions, sessionId);
  if (!chosen) return none;
  return {
    workspacePath: target,
    projectDir,
    sessionFile: chosen.file,
    sessionId: path.basename(chosen.file, ".jsonl"),
    sessionCount: sessions.length,
    updatedAt: chosen.mtime.toISOString(),
  };
}

/**
 * The folder session *sessionId* started in: the `cwd` its transcript records, found by
 * id in any `~/.claude/projects` dir. Null when no transcript holds one (SW-16).
 */
export async function sessionStartDir(sessionId: string): Promise<string | null> {
  // The id comes from a PR file; it must not walk out of the project dir.
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(root, d, `${sessionId}.jsonl`);
    if (!(await isFile(file))) continue;
    const rl = readline.createInterface({
      input: createReadStream(file, "utf-8"),
      crlfDelay: Infinity,
    });
    let scanned = 0;
    try {
      // Every message line carries `cwd`; only a few header lines come first.
      for await (const line of rl) {
        if (++scanned > 50) break;
        try {
          const cwd = JSON.parse(line)?.cwd;
          if (typeof cwd === "string" && cwd) return cwd;
        } catch {
          /* a partial last line */
        }
      }
    } finally {
      rl.close();
    }
  }
  return null;
}

/**
 * Read the newest Claude Code session transcript for a workspace: session ID +
 * the last `limit` user/assistant text messages (tool calls/results and meta
 * lines are skipped). Returns an empty transcript (sessionId null) when the
 * workspace has no sessions yet.
 */
export async function transcriptIn(
  target: string,
  limit = 20,
  sessionId?: string,
): Promise<ClaudeTranscript> {
  const empty: ClaudeTranscript = {
    sessionId: null,
    workspacePath: target,
    messages: [],
    sessionCount: 0,
    updatedAt: null,
  };
  const projectDir = await findClaudeProjectDir(target);
  if (!projectDir) return empty;
  const sessions = await listSessionFiles(projectDir);
  const chosen = pickSession(sessions, sessionId);
  if (!chosen) return empty;

  const resolvedId = path.basename(chosen.file, ".jsonl");
  let text: string;
  try {
    text = await fs.readFile(chosen.file, "utf-8");
  } catch (e) {
    throw new WorkspaceError(`Could not read session file: ${(e as Error).message}`);
  }

  const entries = parseSessionLines(text);

  // Window to the last `limit` conversational (user/assistant) messages,
  // keeping the tool-activity rows that fall inside that window.
  let start = entries.length;
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role !== "tool") {
      count++;
      if (count > limit) break;
    }
    start = i;
  }

  return {
    sessionId: resolvedId,
    workspacePath: target,
    messages: entries.slice(start),
    sessionCount: sessions.length,
    updatedAt: chosen.mtime.toISOString(),
  };
}

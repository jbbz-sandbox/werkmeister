/**
 * Codex sessions on disk (SW-384). Codex writes one JSONL rollout per session under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl ($CODEX_HOME moves the root),
 * filed by date, not by folder: the first line (`session_meta`) records the `cwd` the
 * session started in, which is how a workspace finds its own.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WorkspaceError } from "../../errors.js";
import { windowMessages } from "../sessions.js";
import type { SessionMessage, SessionSource, SessionTranscript } from "../types.js";

export function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

interface CodexSessionFile {
  file: string;
  id: string;
  mtime: Date;
}

/** A rollout's `session_meta` never changes once written, so it is read once per file. */
const metaCache = new Map<string, { id: string; cwd: string } | null>();

async function readMeta(file: string): Promise<{ id: string; cwd: string } | null> {
  if (metaCache.has(file)) return metaCache.get(file) ?? null;
  let meta: { id: string; cwd: string } | null = null;
  const rl = readline.createInterface({
    input: createReadStream(file, "utf-8"),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const p = JSON.parse(line)?.payload;
      if (typeof p?.id === "string" && typeof p?.cwd === "string") meta = { id: p.id, cwd: p.cwd };
      break;
    }
  } catch {
    /* unreadable or partial first line: no meta */
  } finally {
    rl.close();
  }
  // A file still being created has no first line yet; ask again next time.
  if (meta) metaCache.set(file, meta);
  return meta;
}

/**
 * The rollouts whose session started in *dir* or a folder below it, newest mtime first.
 * shortcut: walks the whole store per call (meta is cached); read Codex's
 * state_*.sqlite `threads(cwd, rollout_path)` if a large store measurably lags.
 */
export async function codexSessionsIn(dir: string): Promise<CodexSessionFile[]> {
  const root = codexSessionsRoot();
  let names: string[];
  try {
    names = (await fs.readdir(root, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const roots = [...new Set([dir, await fs.realpath(dir).catch(() => dir)])];
  // A session started in a worktree below the workspace is the workspace's too.
  const owns = (cwd: string) => roots.some((r) => cwd === r || cwd.startsWith(r + path.sep));
  const out: CodexSessionFile[] = [];
  for (const n of names) {
    if (!path.basename(n).startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
    const file = path.join(root, n);
    const meta = await readMeta(file);
    if (!meta || !owns(meta.cwd)) continue;
    try {
      out.push({ file, id: meta.id, mtime: (await fs.stat(file)).mtime });
    } catch {
      /* gone since the walk */
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function pick(sessions: CodexSessionFile[], sessionId?: string): CodexSessionFile | null {
  return (sessionId && sessions.find((s) => s.id === sessionId)) || sessions[0] || null;
}

// User turns Codex writes itself: the AGENTS.md and environment context it injects.
const INJECTED_RE = /^(# AGENTS\.md instructions for|<environment_context>|<user_instructions>)/;

function textOf(content: unknown, kind: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === kind && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

const firstLine = (s: unknown) =>
  String(s ?? "")
    .trim()
    .split("\n")[0]
    .slice(0, 120);

/** A rollout's text as user / assistant messages and compact tool rows ("exec: <code>"). */
export function parseCodexLines(text: string): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; timestamp?: string; payload?: Record<string, any> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload;
    if (e.type !== "response_item" || !p) continue;
    const timestamp = typeof e.timestamp === "string" ? e.timestamp : null;
    if (p.type === "message" && p.role === "user") {
      const t = textOf(p.content, "input_text");
      if (t && !INJECTED_RE.test(t)) out.push({ role: "user", text: t, timestamp });
    } else if (p.type === "message" && p.role === "assistant") {
      const t = textOf(p.content, "output_text");
      if (t) out.push({ role: "assistant", text: t, timestamp });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const detail = firstLine(p.type === "function_call" ? p.arguments : p.input);
      out.push({ role: "tool", text: detail ? `${p.name}: ${detail}` : String(p.name), timestamp });
    }
  }
  return out;
}

/** The newest (or pinned) rollout for *dir*. Codex records the cwd itself, so *startDir* is not needed. */
export async function codexSessionSourceIn(
  dir: string,
  sessionId?: string,
): Promise<SessionSource> {
  const sessions = await codexSessionsIn(dir);
  const chosen = pick(sessions, sessionId);
  return {
    workspacePath: dir,
    // The chosen file's day folder: the tailer watches it for appends and a new rollout.
    projectDir: chosen ? path.dirname(chosen.file) : null,
    sessionFile: chosen?.file ?? null,
    sessionId: chosen?.id ?? null,
    sessionCount: sessions.length,
    updatedAt: chosen?.mtime.toISOString() ?? null,
  };
}

export async function codexTranscriptIn(
  dir: string,
  limit = 20,
  sessionId?: string,
): Promise<SessionTranscript> {
  const sessions = await codexSessionsIn(dir);
  const chosen = pick(sessions, sessionId);
  if (!chosen)
    return { sessionId: null, workspacePath: dir, messages: [], sessionCount: 0, updatedAt: null };
  let text: string;
  try {
    text = await fs.readFile(chosen.file, "utf-8");
  } catch (e) {
    throw new WorkspaceError(`Could not read session file: ${(e as Error).message}`);
  }
  return {
    sessionId: chosen.id,
    workspacePath: dir,
    messages: windowMessages(parseCodexLines(text), limit),
    sessionCount: sessions.length,
    updatedAt: chosen.mtime.toISOString(),
  };
}

/** A session's first own user message (≤80 chars), else its id's first 8 chars. */
export async function codexSessionTitle(file: string, id: string): Promise<string> {
  const text = await fs.readFile(file, "utf-8").catch(() => "");
  const first = parseCodexLines(text).find((m) => m.role === "user");
  return first ? first.text.replace(/\s+/g, " ").slice(0, 80) : id.slice(0, 8);
}

export async function codexListSessionsIn(
  dir: string,
): Promise<Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>> {
  const sessions = await codexSessionsIn(dir);
  return Promise.all(
    sessions.map(async (s, i) => ({
      sessionId: s.id,
      title: await codexSessionTitle(s.file, s.id),
      updatedAt: s.mtime.toISOString(),
      isNewest: i === 0,
    })),
  );
}

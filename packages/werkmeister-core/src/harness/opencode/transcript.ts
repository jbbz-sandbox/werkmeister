/**
 * OpenCode sessions read through its CLI (SW-385, D5), not its SQLite store, whose schema
 * is internal and has changed before. There is no per-session file, so `sessionFile` is null.
 */
import fs from "node:fs/promises";
import { runCapture } from "../../tool_bins.js";
import type { SessionMessage, SessionSource, SessionTranscript, WorkspaceUsage } from "../types.js";
import { resolveOpencodeBin } from "./session.js";

interface ListedSession {
  sessionId: string;
  title: string;
  updatedAt: string;
}

const iso = (t: unknown) => (typeof t === "number" ? new Date(t).toISOString() : null);

async function opencodeJson(args: string[], cwd: string): Promise<any> {
  const { stdout, code } = await runCapture(await resolveOpencodeBin(), args, cwd);
  if (code !== 0) throw new Error(`opencode ${args[0]} exited ${code}`);
  return JSON.parse(stdout);
}

/** Sessions OpenCode started in *dir*, newest first; empty when OpenCode is missing or fails. */
async function sessionsIn(dir: string): Promise<ListedSession[]> {
  const real = await fs.realpath(dir).catch(() => dir);
  let listed: any[];
  try {
    listed = await opencodeJson(["session", "list", "--format", "json"], dir);
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const inDir = await Promise.all(
    listed.map(async (s) => {
      const d = typeof s?.directory === "string" ? s.directory : "";
      return d && (d === dir || (await fs.realpath(d).catch(() => d)) === real) ? s : null;
    }),
  );
  return inDir
    .filter((s) => s && typeof s.id === "string")
    .map((s) => ({
      sessionId: s.id,
      title: String(s.title ?? ""),
      updatedAt: iso(s.updated) ?? iso(s.created) ?? "",
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listSessionsIn(dir: string) {
  return (await sessionsIn(dir)).map((s, i) => ({ ...s, isNewest: i === 0 }));
}

export async function sessionSourceIn(dir: string, sessionId?: string): Promise<SessionSource> {
  const sessions = await sessionsIn(dir);
  const pick = sessionId ? sessions.find((s) => s.sessionId === sessionId) : sessions[0];
  return {
    workspacePath: dir,
    projectDir: null,
    sessionFile: null,
    sessionId: pick?.sessionId ?? sessionId ?? null,
    sessionCount: sessions.length,
    updatedAt: pick?.updatedAt ?? null,
  };
}

/** A tool part as a compact activity row, like claude's `Bash: npm test`. */
function toolRow(part: any): string {
  const input = part?.state?.input ?? {};
  const detail = String(input.command ?? input.path ?? input.filePath ?? "").split("\n")[0];
  const name = String(part?.name ?? "tool");
  return detail ? `${name}: ${detail.slice(0, 120)}` : name;
}

/**
 * One message of `opencode session export` (2.2.5) as transcript rows: a user message's
 * `text`, or an assistant message's text parts then a row per tool part. `idle` rows are left out.
 */
export function messageRows(message: any): SessionMessage[] {
  const role = message?.type;
  if (role !== "user" && role !== "assistant") return [];
  const timestamp = iso(message.time?.created);
  const parts: any[] = Array.isArray(message.content) ? message.content : [];
  const text = (
    role === "user"
      ? String(message.text ?? "")
      : parts
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
  ).trim();
  const rows: SessionMessage[] = text ? [{ role, text, timestamp }] : [];
  for (const p of parts)
    if (p?.type === "tool") rows.push({ role: "tool", text: toolRow(p), timestamp });
  return rows;
}

export async function transcriptIn(
  dir: string,
  limit = 20,
  sessionId?: string,
): Promise<SessionTranscript> {
  const src = await sessionSourceIn(dir, sessionId);
  let messages: SessionMessage[] = [];
  if (src.sessionId) {
    try {
      const exported = await opencodeJson(["session", "export", src.sessionId], dir);
      messages = (exported?.messages ?? []).flatMap(messageRows).slice(-limit);
    } catch {
      /* best-effort, like claude's transcript: an unreadable session reads as empty */
    }
  }
  return {
    sessionId: src.sessionId,
    workspacePath: dir,
    messages,
    sessionCount: src.sessionCount,
    updatedAt: src.updatedAt,
  };
}

const ZERO = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

// shortcut: no token totals for OpenCode sessions (one `session export` per session would be N CLI calls per sweep); read them from one stats call when the dashboard needs them.
export async function usageForDir(name: string, dir: string): Promise<WorkspaceUsage> {
  const sessions = (await sessionsIn(dir)).map((s) => ({
    ...s,
    firstTurn: null,
    lastTurn: null,
    turns: 0,
    models: [],
    totals: { ...ZERO },
    estUsd: null,
  }));
  return { name, totals: { ...ZERO }, estUsd: null, byModel: [], sessions };
}

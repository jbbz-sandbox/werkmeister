/**
 * The harness interface (docs/research/reorganization-proposal.md § 4.3, SW-187):
 * what werkmeister asks of the agent harness it runs under. Built like
 * strategies/types.ts: callers go through `harness()` and never name an adapter.
 *
 * Holds only what today's callers use for sessions. Where a harness reads the
 * context layer from is {@link HarnessLayout} (SW-188), dispatched by harness/layout.ts.
 * Type-only imports, so this file closes no import cycle.
 */
import type { AgentState } from "../agent_state.js";

/** First entry is the default; a workspace.yml without `harness:` reads as claude. */
export const HARNESS_IDS = ["claude", "mcp", "codex", "opencode"] as const;
/**
 * The name of an agent harness, as `harness` in `workspace.yml` spells it:
 * `claude` (the default), `mcp`, `codex` or `opencode`.
 *
 * @example
 * ```ts
 * import { type HarnessId, harnessLayoutFor } from "werkmeister-core/sdk";
 *
 * const id: HarnessId = harnessLayoutFor("/home/me/features/my-workspace").id;
 * if (id !== "claude") console.log(`runs under ${id}`);
 * ```
 */
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * Whether a harness runs werkmeister's hooks ({@link HarnessLayout.hooks}). `true`: it
 * reads Claude-shaped hook files (`.claude/settings.json`, `.codex/hooks.json`).
 * `false`: it has none, and `reason` says why. `"own"`: it has its own hook files,
 * which `write` writes.
 *
 * @example
 * ```ts
 * import { harnessLayoutFor, type HooksSupport } from "werkmeister-core/sdk";
 *
 * const ws = "/home/me/features/my-workspace";
 * const hooks: HooksSupport = harnessLayoutFor(ws).hooks;
 * if (hooks.available === "own") console.log(`wrote ${hooks.write(ws)}; missing: ${hooks.missing}`);
 * else if (!hooks.available) console.warn(hooks.reason);
 * ```
 */
export type HooksSupport =
  | {
      /** It reads Claude-shaped hook files. */
      available: true;
    }
  | {
      /** It runs no hooks. */
      available: false;
      /** Why not, for the printed line. */
      reason: string;
    }
  | {
      /** It has its own hook files. */
      available: "own";
      /** Writes the harness's hook files; returns the main one's path. */
      write(workspaceRoot: string): string;
      /** The werkmeister hooks this harness cannot run, for the printed line and the `hooks` tool. */
      missing: string;
    };

// The projection rows of proposal § 4.3.
/**
 * Where one agent harness reads werkmeister's context in a workspace: its instructions
 * file and skills folder, and whether it takes hooks and subagents. Get one with
 * {@link harnessLayoutFor}.
 *
 * @example
 * ```ts
 * import { type HarnessLayout, harnessLayoutFor } from "werkmeister-core/sdk";
 *
 * const layout: HarnessLayout = harnessLayoutFor("/home/me/features/my-workspace");
 * if (layout.hooks.available === false)
 *   console.warn(`no hooks on ${layout.id}: ${layout.hooks.reason}`);
 * ```
 */
export interface HarnessLayout {
  /** The harness: `claude`, `mcp`, `codex` or `opencode`. */
  readonly id: HarnessId;
  /** The instructions file the harness reads first, such as `CLAUDE.md`. */
  readonly instructionsFile: string;
  /** Workspace-relative folder the harness loads project skills from. */
  readonly skillsDir: string;
  /**
   * Whether werkmeister's hooks run on this harness: `available: true` (Claude-shaped hook
   * files), `false` with a `reason`, or `"own"` when the harness has its own hook files and
   * some hooks (`missing`) don't run.
   */
  readonly hooks: HooksSupport;
  /** Whether subagent definitions (like `.claude/agents`) are written for this harness. */
  readonly agents: boolean;
  /** The tool a human check asks its questions with. Absent means the questions are a plain-text block. */
  readonly questionTool?: string;
  /** A note appended to the instructions file; "" when the harness needs none. */
  notice(): string;
}

/**
 * How {@link sendToClaudeSession} runs one turn.
 *
 * @example
 * ```ts
 * import { sendToClaudeSession, type TurnOptions } from "werkmeister-core/sdk";
 *
 * const opts: TurnOptions = { wait: true, unattended: "/home/me/features/my-workspace" };
 * const sent = await sendToClaudeSession(
 *   "my-workspace",
 *   "Run the tests.",
 *   undefined,
 *   undefined,
 *   opts,
 * );
 * console.log(sent.result?.denied);
 * ```
 */
export interface TurnOptions {
  /**
   * A workspace root whose autonomous-mode permission rules the turn runs under, whether
   * or not the workspace is set `autonomous`. Set it when nobody is there to approve tool calls.
   */
  unattended?: string;
  /** Wait for the turn to end and return a {@link TurnResult}. Without it, the call returns once the turn starts. */
  wait?: boolean;
}

/**
 * What a turn sent with `wait: true` reports once it ends.
 *
 * @example
 * ```ts
 * import { sendToClaudeSession, type TurnResult } from "werkmeister-core/sdk";
 *
 * const { result } = await sendToClaudeSession(
 *   "my-workspace",
 *   "Run the tests.",
 *   undefined,
 *   undefined,
 *   { wait: true },
 * );
 * const done: TurnResult | null = result;
 * for (const call of done?.denied ?? []) console.warn(`needs approval: ${call}`);
 * ```
 */
export interface TurnResult {
  /** The tool calls refused for lack of approval, as `tool: command`. */
  denied: string[];
}

/** One detached turn this process started, keyed by session name in harness/turn.ts. */
export interface TurnState {
  pid: number | null;
  startedAt: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  error: string | null;
}

/**
 * The state of the last turn this process sent to a session. `idle` means this process
 * started none, which is also the case after a restart.
 *
 * @example
 * ```ts
 * import { getClaudeTurnStatus, type TurnStatus } from "werkmeister-core/sdk";
 *
 * const status: TurnStatus = await getClaudeTurnStatus("my-workspace");
 * if (status.state === "failed") console.error(status.error);
 * else console.log(status.state, status.startedAt);
 * ```
 */
export interface TurnStatus {
  /** `idle`, `running`, `done` or `failed`. `failed` covers a non-zero exit and a harness binary that would not start. */
  state: "idle" | "running" | "done" | "failed";
  /** When the turn was started (ISO); null when `idle`. */
  startedAt: string | null;
  /** The harness process's exit code; null while running, when idle, or when it never spawned. */
  exitCode: number | null;
  /** Why the turn failed, with the tail of its stderr; null unless `failed`. */
  error: string | null;
}

/**
 * One entry of a session transcript.
 *
 * @example
 * ```ts
 * import { getClaudeTranscript, type SessionMessage } from "werkmeister-core/sdk";
 *
 * const { messages } = await getClaudeTranscript("my-workspace");
 * const replies: SessionMessage[] = messages.filter((m) => m.role === "assistant");
 * console.log(replies.at(-1)?.text);
 * ```
 */
export interface SessionMessage {
  /** Who wrote it. `tool` entries are short activity rows, such as "Bash: npm test", one per tool call. */
  role: "user" | "assistant" | "tool";
  /** The message text, or the activity row for a tool entry. */
  text: string;
  /** When the harness logged the entry (ISO); null when the line carried none. */
  timestamp: string | null;
}

/**
 * The recent messages of a workspace's newest session (or of the session asked for).
 *
 * @example
 * ```ts
 * import { getClaudeTranscript, type SessionTranscript } from "werkmeister-core/sdk";
 *
 * const t: SessionTranscript = await getClaudeTranscript("my-workspace", 10);
 * console.log(`${t.sessionId ?? "no session"}, ${t.sessionCount} sessions, updated ${t.updatedAt}`);
 * for (const m of t.messages) console.log(`${m.role}: ${m.text}`);
 * ```
 */
export interface SessionTranscript {
  /** Session ID of the session read, or null if there is none. */
  sessionId: string | null;
  /** The folder whose sessions were read. */
  workspacePath: string;
  /** The last N messages, oldest first. */
  messages: SessionMessage[];
  /** Total sessions found for this workspace. */
  sessionCount: number;
  /** mtime of the newest session file (ISO), or null. */
  updatedAt: string | null;
}

/** The newest (or pinned) session file for a folder: what the live tailer watches. */
export interface SessionSource {
  workspacePath: string;
  /** Where the harness files this folder's sessions, or null when it has none. */
  projectDir: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  sessionCount: number;
  updatedAt: string | null;
}

export interface SessionSignal {
  /** Most recent turn state this server tracked (idle = none / after restart). */
  state: "running" | "done" | "failed" | "idle";
  /** Working, needs you (a question or permission prompt), done or idle (SW-46). */
  agent: AgentState;
  /** When `agent` began, or the transcript's mtime when it is inferred from the tail; null with no session. */
  at: string | null;
  /** What `needs-you` is waiting on, when known. */
  question: string | null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}
export interface ModelUsage {
  model: string;
  totals: UsageTotals;
  estUsd: number | null;
}
export interface SessionUsage {
  sessionId: string;
  title: string;
  updatedAt: string;
  firstTurn: string | null;
  lastTurn: string | null;
  /** Assistant lines with usage: the lines the token totals count. */
  turns: number;
  models: string[];
  totals: UsageTotals;
  estUsd: number | null;
  /** Minutes between messages less than 5 min apart; null when the harness reads no timestamps. */
  activeMinutes: number | null;
}
/**
 * A workspace's token usage and estimated cost, summed across its sessions.
 *
 * @example
 * ```ts
 * import { getWorkspaceUsage, type WorkspaceUsage } from "werkmeister-core/sdk";
 *
 * const usage: WorkspaceUsage = await getWorkspaceUsage("my-workspace");
 * console.log(`${usage.sessions.length} sessions, ~$${usage.estUsd?.toFixed(2) ?? "?"}`);
 * for (const m of usage.byModel) console.log(m.model, m.totals.output);
 * ```
 */
export interface WorkspaceUsage {
  /** The workspace name the caller asked about. */
  name: string;
  /** Token counts (`input`, `output`, `cacheCreation`, `cacheRead`) summed over every session and model. */
  totals: UsageTotals;
  /** Estimated cost in USD over the models with a known price; null when none has one. */
  estUsd: number | null;
  /** Active minutes over every session, time two sessions share counted once; null when none has timestamps. */
  activeMinutes: number | null;
  /** Per-model totals, costliest first. */
  byModel: ModelUsage[];
  /** Per-session totals. */
  sessions: SessionUsage[];
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** One headless turn; its answer, or null on any failure. `tools` lets it call MCP tools. */
  ask(prompt: string, opts?: { tools?: boolean }): Promise<string | null>;
  /** {@link HarnessAdapter.ask}, then the JSON object in its answer; null when there is none. */
  askJson(prompt: string, opts?: { tools?: boolean }): Promise<Record<string, unknown> | null>;
  /** {@link HarnessAdapter.ask}, throwing a WorkspaceError that says why it failed. */
  askOrThrow(prompt: string): Promise<string>;
  /** Start one turn in *cwd*, continuing *sessionId* (a new session when null); *key* names it for {@link HarnessAdapter.turnStatus}. Null unless `opts.wait`. */
  sendTurn(
    key: string,
    cwd: string,
    body: string,
    sessionId: string | null,
    model: string | null,
    opts?: TurnOptions,
  ): Promise<TurnResult | null>;
  turnStatus(key: string): TurnStatus;
  /** The newest (or pinned) session started in *dir*, read as messages. */
  transcript(dir: string, limit?: number, sessionId?: string): Promise<SessionTranscript>;
  /** The newest (or pinned) session file for *dir*; *startDir* when sessions are filed under a folder below it. */
  sessionSource(dir: string, sessionId?: string, startDir?: string): Promise<SessionSource>;
  /** The folder session *sessionId* of *dir* started in (it may be below *dir*); null when no session has that id. */
  sessionStartDir(dir: string, sessionId: string): Promise<string | null>;
  /** Sessions started in *dir*, newest first, with a display title. */
  listSessions(
    dir: string,
  ): Promise<Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>>;
  /** One session file's text as messages, for the live tailer (the rows {@link HarnessAdapter.transcript} returns). */
  parseSession(text: string): SessionMessage[];
  /** Working / needs you / done / idle for the workspace list. */
  agentSignal(
    key: string,
    dir: string,
    src: { sessionFile: string | null; updatedAt: string | null } | null,
  ): Promise<{ signal: SessionSignal; lastActivity: string | null }>;
  /** Token totals and cost estimate for the sessions started in *dir*. */
  usage(name: string, dir: string): Promise<WorkspaceUsage>;
  /** Shell command that reopens a session interactively; *prompt* becomes its first message. */
  resumeCommand(sessionId: string | null, model: string | null, prompt?: string): string;
  /** Shell command that starts a tools-off PR-reconcile session in *dir*. */
  reconcileCommand(dir: string, ctxFile: string, prompt: string): string;
}

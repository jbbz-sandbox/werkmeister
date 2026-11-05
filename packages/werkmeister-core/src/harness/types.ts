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
export const HARNESS_IDS = ["claude", "mcp", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type HooksSupport = { available: true } | { available: false; reason: string };

/** Where one harness reads werkmeister's context layer (proposal § 4.3 projection rows). */
export interface HarnessLayout {
  readonly id: HarnessId;
  /** The file the harness reads first. */
  readonly instructionsFile: string;
  /** Workspace-relative dir the harness loads project skills from. */
  readonly skillsDir: string;
  readonly hooks: HooksSupport;
  /** Whether `.claude/agents`-style subagent definitions are projected. */
  readonly agents: boolean;
  /** Appended to the instructions file; "" when the harness needs no note. */
  notice(): string;
}

export interface TurnOptions {
  /** Workspace root whose autonomous rules the turn gets, `autonomous` or not: nobody is there to approve (SW-313). */
  unattended?: string;
  /** Wait for the turn to end and return a {@link TurnResult}. */
  wait?: boolean;
}

export interface TurnResult {
  /** The calls refused for lack of approval, as `tool: command`. */
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

/** {@link TurnState} for callers; `idle` means this process started no turn (also after a restart). */
export interface TurnStatus {
  state: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface SessionMessage {
  /** "tool" entries are compact activity rows ("Bash: npm test") from tool_use blocks. */
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp: string | null;
}

export interface SessionTranscript {
  /** Session ID of the newest session, or null if none. */
  sessionId: string | null;
  workspacePath: string;
  /** Last N user/assistant text messages, oldest first. */
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
}
export interface WorkspaceUsage {
  name: string;
  totals: UsageTotals;
  estUsd: number | null;
  byModel: ModelUsage[];
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
  /** Sessions started in *dir*, newest first, with a display title. */
  listSessions(
    dir: string,
  ): Promise<Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>>;
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

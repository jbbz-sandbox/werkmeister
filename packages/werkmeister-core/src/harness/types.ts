/**
 * The harness interface (docs/research/reorganization-proposal.md § 4.3, SW-187):
 * what werkmeister asks of the agent harness it runs under. Built like
 * strategies/types.ts: callers go through `harness()` and never name an adapter.
 *
 * Holds only what today's callers use. Hooks, skills, agents and MCP projection
 * still import harness/claude/ directly; SW-188 abstracts them for a second adapter.
 * Type-only imports, so this file closes no import cycle.
 */
import type { ClaudeSessionSignal, turnStatus } from "./claude/session.js";
import type { ClaudeTranscript, sessionSourceIn } from "./claude/transcript.js";
import type { WorkspaceUsage } from "./claude/usage.js";

export type HarnessId = "claude";

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** One headless turn; its answer, or null on any failure. `tools` lets it call MCP tools. */
  ask(prompt: string, opts?: { tools?: boolean }): Promise<string | null>;
  /** {@link ask}, then the JSON object in its answer; null when there is none. */
  askJson(prompt: string, opts?: { tools?: boolean }): Promise<Record<string, unknown> | null>;
  /** {@link ask}, throwing a WorkspaceError that says why it failed. */
  askOrThrow(prompt: string): Promise<string>;
  /** Start one turn in *cwd*, continuing *sessionId* (a new session when null); *key* names it for {@link turnStatus}. */
  sendTurn(
    key: string,
    cwd: string,
    body: string,
    sessionId: string | null,
    model: string | null,
  ): Promise<void>;
  turnStatus(key: string): ReturnType<typeof turnStatus>;
  /** The newest (or pinned) session started in *dir*, read as messages. */
  transcript(dir: string, limit?: number, sessionId?: string): Promise<ClaudeTranscript>;
  sessionSource(...args: Parameters<typeof sessionSourceIn>): ReturnType<typeof sessionSourceIn>;
  /** Sessions started in *dir*, newest first, with a display title. */
  listSessions(
    dir: string,
  ): Promise<Array<{ sessionId: string; title: string; updatedAt: string; isNewest: boolean }>>;
  /** Working / needs you / done / idle for the workspace list. */
  agentSignal(
    key: string,
    dir: string,
    src: { sessionFile: string | null; updatedAt: string | null } | null,
  ): Promise<{ signal: ClaudeSessionSignal; lastActivity: string | null }>;
  /** Token totals and cost estimate for the sessions started in *dir*. */
  usage(name: string, dir: string): Promise<WorkspaceUsage>;
  /** Shell command that reopens a session interactively. */
  resumeCommand(sessionId: string | null, model: string | null): string;
  /** Shell command that starts a tools-off PR-reconcile session in *dir*. */
  reconcileCommand(dir: string, ctxFile: string, prompt: string): string;
}

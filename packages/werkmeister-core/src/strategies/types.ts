/**
 * The context-strategy interface (docs/context-strategies.md, option B).
 *
 * A strategy owns every write to a workspace's context layer: CLAUDE.md and
 * whatever the agent reads besides it. `initWorkspace`, `up`, `sandbox
 * skills|notes context|hooks gate` and the MCP skills/hooks tools each make one
 * call through `strategyFor` and never name a strategy.
 *
 * No runtime imports: `workspace_prompts.ts` reads `STRATEGY_IDS` for the
 * wizard, and anything heavier here would close an import cycle through `jit.ts`.
 */

import type { Note } from "../notes.js";

/** First entry is the default for new workspaces; a workspace.yml without the key still reads as jit (pre-field layouts). */
export const STRATEGY_IDS = ["icm", "jit"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

/** Everything init has resolved before the context layer is written. */
export interface InitContext {
  workspaceRoot: string;
  workspaceName: string;
  /** [name, branch] per repo worktree, as `discoverRepos` returns them. */
  repos: Array<[string, string]>;
  task: string;
  /** FEATURE, SERVICES, ... — the .env metadata map. */
  meta: Record<string, string>;
  /** Resolved workspace.yml inputs: starting_prompt, work_type, ... */
  inputs: Record<string, string>;
  /** `args["config"]` — a workspace config path overriding .sandbox/workspace.yml. */
  configOverride: string | null;
  /** The workspace's issue (`.sandbox/issue.md`, else just `issue_id`); null/absent when it has none. */
  issue?: IssueRef | null;
  /** True only on the creation run (initWorkspace was handed the fetched snapshot). */
  isCreate?: boolean;
}

export interface ContextStrategy {
  readonly id: StrategyId;
  /** initWorkspace's context-layer step. Idempotent; re-run on every init. */
  init(ctx: InitContext): void;
  /** Called by `up` after secrets are validated and before the slot is allocated. */
  refresh(workspaceRoot: string): void;
  /** Backs `sandbox skills check` and MCP `skills` tool. Empty array = fresh. */
  check(workspaceRoot: string): string[];
  /** Backs `sandbox skills sync` and MCP `skills` tool. */
  sync(workspaceRoot: string): { wrote: string[] };
  /** SessionStart re-injection text, or null. Backs `sandbox notes context`. */
  sessionContext(workspaceRoot: string, hookPayload: Record<string, unknown>): string | null;
  /** PreToolUse gate. Backs `sandbox hooks gate`; must fail open. */
  gate(): void;
  /** Workspace-relative paths this strategy owns. A trailing `*` in the last segment is a prefix glob. */
  ownedPaths(): string[];
  /** Where graduation (`notes graduate`, `down`, MCP `notes`) finds decisions and records their state. */
  readonly decisions: DecisionSource;
}

/** A strategy's decisions, as the graduate.ts scaffold path consumes them. */
export interface DecisionSource {
  /** Decisions not yet graduated or superseded (so `graduating` ones too), in sequence order. */
  open(workspaceRoot: string): Note[];
  /** Merge *fields* (`status`, `graduated_to`) into *note*'s recorded state. */
  mark(workspaceRoot: string, note: Note, fields: Record<string, string>): void;
  /** What a `TODO(graduate)` marker tells the author to fill from: `note 003, see <path>`. */
  cite(workspaceRoot: string, note: Note): string;
}

/** The workspace's issue as the context layer renders it; `fetchedAt` null = no stored copy. */
export interface IssueRef {
  ref: string;
  url: string | null;
  title: string;
  fetchedAt: string | null;
}

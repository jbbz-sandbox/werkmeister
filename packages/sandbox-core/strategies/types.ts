/**
 * The context-strategy interface (docs/context-strategies.md, option B).
 *
 * A strategy owns every write to a workspace's context layer: CLAUDE.md and
 * whatever the agent reads besides it. `initWorkspace`, `up`, `sandbox
 * skills|notes context|hooks gate` and the MCP skills/hooks tools each make one
 * call through `strategyFor` and never name a strategy.
 *
 * No imports: `workspace_prompts.ts` reads `STRATEGY_IDS` for the wizard, and
 * anything heavier here would close an import cycle through `jit.ts`.
 */

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
  /** Backs `sandbox skills check` and MCP sandbox-skills. Empty array = fresh. */
  check(workspaceRoot: string): string[];
  /** Backs `sandbox skills sync` and MCP sandbox-skills. */
  sync(workspaceRoot: string): { wrote: string[] };
  /** SessionStart re-injection text, or null. Backs `sandbox notes context`. */
  sessionContext(workspaceRoot: string, hookPayload: Record<string, unknown>): string | null;
  /** PreToolUse gate. Backs `sandbox hooks gate`; must fail open. */
  gate(): void;
  /** Workspace-relative paths this strategy owns. A trailing `*` in the last segment is a prefix glob. */
  ownedPaths(): string[];
}

/** The workspace's issue as the context layer renders it; `fetchedAt` null = no stored copy. */
export interface IssueRef {
  ref: string;
  url: string | null;
  title: string;
  fetchedAt: string | null;
}

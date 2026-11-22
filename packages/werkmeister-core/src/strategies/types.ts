/**
 * The context-strategy interface (docs/context-strategies.md, option B).
 *
 * A strategy owns every write to a workspace's context layer: CLAUDE.md and
 * whatever the agent reads besides it. `initWorkspace`, `up`, `werkmeister
 * skills|notes context|hooks gate` and the MCP skills/hooks tools each make one
 * call through `strategyFor` and never name a strategy.
 *
 * No runtime imports: `workspace_prompts.ts` reads `STRATEGY_IDS` for the
 * wizard, and anything heavier here would close an import cycle through `jit.ts`.
 */

import type { Note } from "../notes.js";

/** First entry is the default for new workspaces; a workspace.yml without the key still reads as jit (pre-field layouts). */
export const STRATEGY_IDS = ["icm", "jit"] as const;
/**
 * The name of a context strategy, as `context_strategy` in `workspace.yml` spells it:
 * `icm` (staged pipeline folders, the default) or `jit`.
 *
 * @example
 * ```ts
 * import { type StrategyId, strategyFor } from "werkmeister-core/sdk";
 *
 * const id: StrategyId = strategyFor("/home/me/features/my-workspace").id;
 * console.log(id === "icm" ? "staged pipeline" : "just-in-time standards");
 * ```
 */
export type StrategyId = (typeof STRATEGY_IDS)[number];

/**
 * Everything `werkmeister workspace init` has resolved before a context strategy
 * writes the context layer; the argument to {@link ContextStrategy.init}.
 *
 * @example
 * ```ts
 * import { type InitContext, strategyFor } from "werkmeister-core/sdk";
 *
 * const root = "/home/me/features/my-workspace";
 * const ctx: InitContext = {
 *   workspaceRoot: root,
 *   workspaceName: "my-workspace",
 *   repos: [["my-app", "me/my-workspace"]],
 *   task: "Add a health endpoint",
 *   meta: { FEATURE: "my-workspace" },
 *   inputs: {},
 *   configOverride: null,
 * };
 * strategyFor(root).init(ctx);
 * ```
 */
export interface InitContext {
  /** The workspace folder's absolute path. */
  workspaceRoot: string;
  /** The workspace folder's name. */
  workspaceName: string;
  /** [name, branch] per repo worktree, as `discoverRepos` returns them. */
  repos: Array<[string, string]>;
  /** The task text the context layer states. */
  task: string;
  /** FEATURE, SERVICES, ... — the .env metadata map. */
  meta: Record<string, string>;
  /** Resolved workspace.yml inputs: starting_prompt, work_type, ... */
  inputs: Record<string, string>;
  /** `args["config"]` — a workspace config path overriding .werkmeister/workspace.yml. */
  configOverride: string | null;
  /** The workspace's issue (`.werkmeister/issue.md`, else just `issue_id`); null/absent when it has none. */
  issue?: IssueRef | null;
  /** True only on the creation run (initWorkspace was handed the fetched snapshot). */
  isCreate?: boolean;
}

/**
 * How a workspace's context layer (its `CLAUDE.md` and whatever else the agent
 * reads) is written, kept fresh and fed to the agent. There are two: `icm`
 * (staged pipeline folders) and `jit` (standards and skills delivered as the
 * agent works). Get the one a workspace uses from {@link strategyFor}. Every
 * method runs in-process on the workspace's files.
 *
 * @example
 * ```ts
 * import { resolveWorkspaceDir, strategyFor, type ContextStrategy } from "werkmeister-core/sdk";
 *
 * const dir = await resolveWorkspaceDir("my-workspace");
 * const strategy: ContextStrategy = strategyFor(dir);
 * if (strategy.check(dir).length) console.log(`synced: ${strategy.sync(dir).wrote.join(", ")}`);
 * ```
 */
export interface ContextStrategy {
  /** The `context_strategy` value in `workspace.yml` that selects this strategy: `icm` or `jit`. */
  readonly id: StrategyId;
  /** Writes the context layer during `werkmeister workspace init`. Safe to re-run. */
  init(ctx: InitContext): void;
  /** Refreshes the context layer; `werkmeister feature up` calls it before starting containers. */
  refresh(workspaceRoot: string): void;
  /** Lists what is out of date in the context layer, one message each; empty means fresh. Same as `werkmeister skills check`. */
  check(workspaceRoot: string): string[];
  /** Rewrites whatever {@link ContextStrategy.check} found out of date. Same as `werkmeister skills sync`. */
  sync(workspaceRoot: string): {
    /** The files it rewrote; empty when nothing had drifted. */
    wrote: string[];
  };
  /** Text to re-inject into the agent's context at session start, or null for none. Same as `werkmeister notes context`. */
  sessionContext(workspaceRoot: string, hookPayload: Record<string, unknown>): string | null;
  /** The pre-tool-use hook gate. It fails open: a problem in the gate never blocks the agent. */
  gate(): void;
  /** Workspace-relative paths this strategy writes and owns. A trailing `*` in the last segment matches any name with that prefix. */
  ownedPaths(): string[];
  /** Where the workspace's recorded decisions are listed and marked as graduated into standards. */
  readonly decisions: DecisionSource;
}

/**
 * Where a workspace's recorded decisions live: listed, marked as graduated, and
 * cited from the standards. Each {@link ContextStrategy} has one; pass it to
 * {@link graduateNote} as `decisions` to graduate a decision it lists.
 *
 * @example
 * ```ts
 * import { type DecisionSource, graduateNote, strategyFor } from "werkmeister-core/sdk";
 *
 * const ws = "/home/me/features/my-workspace";
 * const decisions: DecisionSource = strategyFor(ws).decisions;
 * const [first] = decisions.open(ws);
 * if (first) graduateNote(ws, first, { domain: "testing", kind: "rule", decisions });
 * ```
 */
export interface DecisionSource {
  /** Decisions not yet graduated or superseded (so `graduating` ones too), in sequence order. */
  open(workspaceRoot: string): Note[];
  /** Merge *fields* (`status`, `graduated_to`) into *note*'s recorded state. */
  mark(workspaceRoot: string, note: Note, fields: Record<string, string>): void;
  /** What a `TODO(graduate)` marker tells the author to fill from: the decision's number and where it is recorded. */
  cite(workspaceRoot: string, note: Note): string;
}

/** The workspace's issue as the context layer renders it; `fetchedAt` null = no stored copy. */
export interface IssueRef {
  ref: string;
  url: string | null;
  title: string;
  fetchedAt: string | null;
  /** The parent epic from the stored copy (SW-633). */
  parent?: { ref: string; title: string; url: string | null };
}

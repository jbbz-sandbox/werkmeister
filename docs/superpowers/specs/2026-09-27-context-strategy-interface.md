# Context strategy interface — spec

**Status:** proposed
**Scope:** `packages/sandbox-core` (`workspace_init.ts`, `lifecycle.ts`, `workspace_prompts.ts`, new `strategies/`), `apps/cli/src/commands/{skills,notes,hooks}.ts`, `apps/mcp/tools.ts`, `apps/cli/infra/schemas/workspace.schema.json`, `docs/jit-context-system.md`, `docs/context-strategies.md`.
**Related:** `2026-09-27-work-type-phases.md` — work type selects the JIT phase sequence and pre-implementation gate; the ICM stage templates in §3.5 should read the same `WORK_TYPE_PHASES` table.
**Precedes:** `docs/context-strategies.md` (option B). Evidence: `~/features/COMPARISON.md`, known-issues "`sandbox up` Re-Installs the Session Hooks Unconditionally".

## 1. Problem

The workspace context layer (CLAUDE.md, `.claude/skills/sb-*`, `.claude/agents/sb-*`, `.claude/settings.json` hooks, `.sandbox/notes/`, `.sandbox/standards.json`) is written by five places that do not know about each other: `initWorkspace` steps 5b–6c (`workspace_init.ts:902-977`), `up` (`lifecycle.ts:133`), `sandbox skills sync`, and the MCP tools `sandbox-skills` and `sandbox-hooks` (`apps/mcp/tools.ts:489`, `:518`). All five assume the JIT layer. A workspace that uses a different layer — the ICM pipeline built by hand in `~/features/icm-ws2` — has no way to say so, and `up` silently re-installs the JIT hooks into it. Adding a `context_strategy` field with an `if` at each of the five sites (option A) fixes today's writers and will be forgotten by the sixth.

## 2. Goals

1. One field in `workspace.yml` selects the context layer; one module per strategy owns every write to it.
2. `initWorkspace`, `up`, the three JIT CLI commands and the two MCP tools have exactly one dispatch point each, and none of them names `jit` or `icm`.
3. Existing workspaces (no field) behave byte-for-byte as today.
4. An ICM workspace created by the CLI matches `~/features/icm-ws2` after its run-2 fixes, and `sandbox up` inside it leaves `.claude/` absent.

Non-goals: moving sb-* skills into a plugin (option C); a third strategy; changing what JIT writes; changing the standards tree or its resolver; per-stage ICM templates beyond `work_type`.

## 3. Design

### 3.1 The field

`context_strategy: "jit" | "icm"` in `.sandbox/workspace.yml`. Default `jit` when absent.

- Schema: one property beside `work_type`, `enum: ["jit", "icm"]`, description "Which context layer init-workspace generates and up refreshes."
- Plumbing: one row in `_INPUT_FIELDS` (`workspace_prompts.ts:107`): `["context_strategy", "SANDBOX_CONTEXT_STRATEGY", "context_strategy"]`, and one `PromptSpec` in `_WIZARD_PROMPTS` beside `work_type` (select, default `jit`) so `--context-strategy` reaches `workspace`, `init-workspace`, `--print-prompts`, `--print-form-schema` and the browser form for free.
- Read: `readContextStrategy(workspaceRoot): StrategyId` in `strategies/index.ts` — `loadConfigFile` → field → validate → default `jit`. Unknown value throws `SandboxError("UNKNOWN_CONTEXT_STRATEGY")` listing the registry keys; never falls back silently.

### 3.2 The interface

`packages/sandbox-core/strategies/types.ts`:

```ts
export type StrategyId = "jit" | "icm";

/** Everything init has resolved before the context layer is written. */
export interface InitContext {
  workspaceRoot: string;
  workspaceName: string;
  repos: Array<[string, string]>;           // [name, path] as initWorkspace holds them
  task: string;
  meta: Record<string, string>;             // FEATURE, SERVICES, ... (the .env metadata map)
  inputs: Record<string, string>;           // resolved starting_prompt, work_type, ...
  hasServiceMap: boolean;
  configOverride: string | null;            // args["config"]
  report: Reporter;                         // info/warn/success, already threaded through init
}

export interface ContextStrategy {
  readonly id: StrategyId;
  /** initWorkspace step 6 (all of 5b–6c today). Idempotent; re-run on every init. */
  init(ctx: InitContext): void;
  /** Called by `up` after secrets are validated and before the slot is allocated. */
  refresh(workspaceRoot: string): void;
  /** Backs `sandbox skills check`. Empty array = fresh. */
  check(workspaceRoot: string): string[];
  /** Backs `sandbox skills sync` and the MCP sandbox-skills tool. */
  sync(workspaceRoot: string): { wrote: string[] };
  /** SessionStart re-injection text, or null. Backs `sandbox notes context`. */
  sessionContext(workspaceRoot: string, hookPayload: Record<string, unknown>): string | null;
  /** PreToolUse gate. Backs `sandbox hooks gate`; must fail open. */
  gate(): void;
  /** Files/dirs this strategy owns at the workspace root, for `remove`/drift and for tests. */
  ownedPaths(): string[];
}
```

`strategies/index.ts`: `const REGISTRY: Record<StrategyId, ContextStrategy> = { jit, icm }`, `strategyFor(workspaceRoot)`, `readContextStrategy`. Nothing outside `strategies/` imports `jit.ts` or `icm.ts`.

### 3.3 `strategies/jit.ts` — a move, not a rewrite

- `init`: the bodies of steps 5b, 6, 6a, 6b, 6c lifted verbatim from `workspace_init.ts:902-977`. Step 6d (MCP) and 6e (plugin drift) stay in `initWorkspace`: `.mcp.json` is archetype-driven and both strategies want it.
- `refresh`: `writeWorkspaceHooks(workspaceRoot)` (the `lifecycle.ts:133` call).
- `check` / `sync`: `checkSkills` / `syncSkills` from `apps/cli/src/commands/skills.ts:269,314` — these move into core (`skills_sync.ts`) so the MCP tool and the CLI share them; today the MCP server imports from the CLI package.
- `sessionContext`: the body of `notes.ts:216-233` (`resetSessionState` on compact/clear, then `buildContext`).
- `gate`: `gate.main` (`gate.ts:270`).
- `ownedPaths`: `CLAUDE.md`, `.claude/settings.json`, `.claude/skills/sb-*`, `.claude/agents/sb-*`, `.sandbox/notes`, `.sandbox/standards.json`, `.sandbox/.gate`.

No JIT output changes. `hooks_gen.test.ts`, `lifecycle_up_hooks.test.ts`, `standards_*.test.ts` must pass without edits other than import paths.

### 3.4 `strategies/icm.ts` — the new renderer

Writes, from `InitContext` only:

| File | Content | Source |
|---|---|---|
| `CLAUDE.md` | router, ≤60 lines: identity line, "Where things live" table, the `sandbox`-command warning, "Route by what just happened" table, "The one rule" | `workspaceName`, `repos`, `task`, `meta.FEATURE`; stage names from the template |
| `CONTEXT.md` | pipeline table: stage, does, writes; factory/product paragraph; ".gitkeep does not count" | template |
| `BRIEF.md` | frontmatter `source: .sandbox/workspace.yml (starting_prompt)`, `# Brief: <task>`, then `inputs.starting_prompt` verbatim | inputs |
| `_shared/standards.md` | one row per active standard: domain, `<standardsDir>/<domain>/STANDARD.md`, `applies_to` from module frontmatter; "Not applicable" line for the rest; the recitation rule | `resolveActiveStandards` + `loadStandardsModules` — the same call step 5b makes; `writeStandardsManifest` is **not** called (no gate) |
| `stages/NN_<name>/CONTEXT.md` | contract: one-job line, Inputs (working / reference), Do NOT load, Process, Outputs, Human check | template for `inputs.work_type` |
| `stages/NN_<name>/output/.gitkeep` | — | — |

Template (`strategies/icm_templates.ts`), keyed by `work_type`:

| work_type | Stages |
|---|---|
| feature | 01_research (inventory + `decisions.md` with the brief's open questions, each `status: proposed`) → 02_spec → 03_implement → 04_ship |
| bugfix, incident | 01_reproduce → 02_fix → 03_verify → 04_ship |
| refactor | 01_scope → 02_implement → 03_ship |
| spike | 01_questions → 02_findings |

Contract text is the `~/features/icm-ws2/stages/*/CONTEXT.md` set generalised: `demo-services`/`apps/backend` become `<repo>`/paths from the brief; container name is `${FEATURE}-<service>` for each service in `meta.SERVICES`; the run-2 lessons are baked in — a `decided` status **is** the approval (no re-confirmation), verification uses `docker restart <container>` and never `sandbox up|restart|init-workspace`, the test command is quoted from `sandbox-context.md` rather than restated. Standards rows named by a contract must exist in `_shared/standards.md`; the renderer drops a row from a contract when the domain is not active. The ponytail row says the plugin's SessionStart hook already loads it and to invoke the skill only if `PONYTAIL MODE ACTIVE` is missing.

Other members:

- `refresh`: **removes** `.claude/settings.json` managed entries if present (`hooks_gen._isManaged`), and `.sandbox/.gate/`. This is the repair path for a workspace polluted before this change; it never touches unmanaged hook entries.
- `check`: re-render `_shared/standards.md` and each `stages/*/CONTEXT.md` in memory and diff. `BRIEF.md` and `CLAUDE.md` are never re-checked after first write — the first is the operator's, the second is small enough to hand-edit and the brief warns against rerunning init anyway. Returns paths that differ.
- `sync`: rewrite exactly the paths `check` reports. Never touches `stages/*/output/`.
- `sessionContext`: `null`. ICM's re-injection is the route table the agent reads by itself; there is no hook.
- `gate`: no-op, exit 0.
- `ownedPaths`: `CLAUDE.md`, `CONTEXT.md`, `BRIEF.md`, `_shared`, `stages`.

Write-once rule: `init` writes `BRIEF.md` only if absent (same rule as `seedStartingHandoff`), and never writes into an existing `stages/*/output/`.

### 3.5 Dispatch points (the whole diff outside `strategies/`)

| Site | Before | After |
|---|---|---|
| `workspace_init.ts:902-977` | steps 5b–6c inline | `strategyFor(workspaceRoot).init(ctx)` (one call; steps 6d/6e follow unchanged) |
| `lifecycle.ts:133` | `writeWorkspaceHooks(workspace)` | `strategyFor(workspace).refresh(workspace)` |
| `commands/skills.ts` | `checkSkills` / `syncSkills` | `strategy.check` / `strategy.sync`; exit 1 on non-empty check as today |
| `commands/notes.ts` `context` | inline | `strategy.sessionContext(ws, payload)`; still wrapped in the never-throw `try` |
| `commands/hooks.ts` | `gateMain()` | `strategy.gate()` — **except** the `./sandbox` wrapper fast path (`sandbox:94-97`) which execs `dist/lib/gate.js` directly; that path stays JIT-only because only JIT installs the hook that reaches it |
| `apps/mcp/tools.ts:489` | `syncSkills` / `checkSkills` | `strategy.sync` / `strategy.check` |
| `apps/mcp/tools.ts:518` `sandbox-hooks` | `writeWorkspaceHooks` | `strategy.refresh`; tool description reworded to "refresh the workspace's context layer" |
| `lifecycle.ts` `teardownNotes` / `down.ts` | always | unchanged — `latestHandoff`/`openDecisions`/`reconcileGraduating` already return empty when `.sandbox/notes` is absent; verify with a test rather than add a branch |
| `plugin_check.ts` | always | unchanged (plugin drift is about the `sandbox-tools` plugin, not the layer) |

`workspace remove` / `remove-workspace` need nothing: they delete the worktree.

### 3.6 Switching strategy on an existing workspace

Editing `context_strategy` in `workspace.yml` and rerunning `init-workspace` runs the new strategy's `init`. It does **not** delete the old strategy's `ownedPaths()`; init prints them as a warning ("jit layer still present: .claude/skills/sb-*, …; remove by hand or run `sandbox init-workspace --prune-context`"). `--prune-context` deletes the previous strategy's `ownedPaths()` minus anything with uncommitted edits (same guard `reconcileWorktrees` uses for repos). Recording the previous strategy: init writes `context_strategy` into `workspace.yml` on every run already (2a persists all inputs), so "previous" is simply the value read at the start of init before 2a overwrites it.

## 4. Compatibility

- No field → `jit`. Every existing test fixture has no field, so the whole suite is a regression check for goal 3.
- `writeWorkspaceHooks` keeps its export; `lifecycle_up_hooks.test.ts` keeps testing it through `up` (default strategy).
- The MCP `sandbox-hooks` tool keeps its name; only its body and description change.
- `docs/jit-context-system.md` §5 gains one sentence: "These artifacts are written by the `jit` strategy (`strategies/jit.ts`); `context_strategy` in workspace.yml selects it." §11 Portability gains a pointer to `strategies/icm.ts` as the worked example of R2/R3 with no hooks.

## 5. Tests

`packages/sandbox-core/__tests__/strategies/`:

1. `registry.test.ts` — absent field → `jit`; `"icm"` → icm; `"foo"` → `UNKNOWN_CONTEXT_STRATEGY`.
2. `icm_init.test.ts` — temp workspace with a `starting_prompt`, `work_type: feature`, one repo, one service, a stub standards dir with `comments` + `ui`: asserts the six files, `BRIEF.md` body equals the prompt, `_shared/standards.md` lists `comments` and marks `ui` not applicable, `stages/` has four dirs with `.gitkeep`, **no** `.claude/`, **no** `.sandbox/notes`, **no** `standards.json`. Rerun: `BRIEF.md` untouched after editing it; `stages/01_research/output/x.md` survives.
3. `icm_refresh.test.ts` — seed `.claude/settings.json` with one managed and one hand-added hook plus `.sandbox/.gate/s.json`; `refresh` leaves only the hand-added hook and deletes `.gate`.
4. `lifecycle_up_strategy.test.ts` — clone of `lifecycle_up_hooks.test.ts` with `context_strategy: icm` in a stub `workspace.yml`: after `up`, `.claude/settings.json` is absent. This is the regression test for the known issue.
5. `jit_unchanged.test.ts` — snapshot of every file `jit.init` writes for the existing `workspace_init` fixture, taken before the refactor on `main`, asserted equal after.
6. CLI: `skills check` in an icm workspace exits 0 with "context layer fresh (icm)"; `notes context` prints nothing; `hooks gate` exits 0.

Harness cell (`docs/experiments/context-management`): create both strategies from the same inputs and diff `find . -type f | sort` against the two expected manifests.

## 6. Rollout

1. `strategies/types.ts`, `index.ts`, `jit.ts` (pure move) + dispatch in `initWorkspace` and `up`; run the suite; snapshot test 5. **No behavior change ships here.**
2. Field: schema, `_INPUT_FIELDS`, `PromptSpec`, `readContextStrategy`; test 1.
3. `icm.ts` + `icm_templates.ts` (feature template first, from `~/features/icm-ws2`); tests 2–4.
4. CLI/MCP dispatch (`skills`, `notes`, `hooks`, two tools); test 6; docs.
5. Remaining `work_type` templates; `--prune-context`.

Each step is one PR and leaves `main` shippable.

## 7. Open questions

1. **Standards pointers vs copies for ICM.** `_shared/standards.md` points at `standardsDirPath()`; a workspace shared with someone whose standards checkout lives elsewhere gets dead links. JIT copies. Proposal: pointers (one home per fact, matches how icm-ws2 ran), and render the path from `standardsDirPath()` at init so it is at least correct for the machine that created it.
2. **Should `icm.refresh` really delete managed hooks?** It is the only way an already-polluted workspace heals on `up`, and `_isManaged` is precise. Alternative: warn only. Proposal: delete, log each removed entry.
3. **Does the ICM `CLAUDE.md` need the `sandbox`-command warning once `up` is strategy-aware?** After step 1 it is safe to run `sandbox up` in an ICM workspace, so the warning shrinks to "do not rerun `init-workspace` without reading §3.6". Keep the `docker restart` instruction; it is still the cheaper reload.
4. **`sb-tester-<archetype>` agents.** They are archetype-driven, not strategy-driven, and stage 03/04 contracts could name them. Left in `jit.init` for now; move to `initWorkspace` step 6d alongside MCP if ICM wants them.

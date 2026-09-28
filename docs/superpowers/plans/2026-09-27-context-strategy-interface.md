# Context Strategy Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `context_strategy: jit | icm` field in `workspace.yml` selects the workspace's context layer. One module per strategy owns every write to that layer, and `initWorkspace`, `up`, the three JIT CLI commands and the two MCP tools each dispatch through one call.

**Architecture:** `packages/sandbox-core/strategies/` holds `types.ts` (the `ContextStrategy` interface), `jit.ts` (steps 5b–6c of `initWorkspace` moved verbatim), `icm.ts` + `icm_templates.ts` (a new staged-folder renderer), and `index.ts` (the registry: `strategyFor`, `strategyById`, `readContextStrategy`). Nothing outside `strategies/` imports `jit.ts` or `icm.ts`. A byte-for-byte snapshot of JIT init output is captured on `main` before the move and has to pass unchanged afterwards.

**Tech Stack:** TypeScript (ESM, ES2022), `tsc`. Core tests are flat `*.test.mjs` files in `packages/sandbox-core/` that run on `node:test` against `./dist/`. Run them with `cd packages/sandbox-core && npx tsc && node --test <file>.test.mjs`, or `npm test` in that directory for the whole suite. CLI tests use vitest under `apps/cli/src/**/__tests__/` and import `sandbox-core/*` from `dist`, so rebuild core first: `npm run build -w sandbox-core && cd apps/cli && npx vitest run <path>`. MCP type-checks with `cd apps/mcp && npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-27-context-strategy-interface.md`

## Before you start

- This checkout is on `main` (`b6869a7`), and every line reference below is against it. Create the branch with `git checkout -b feat/context-strategy`.
- The working tree has uncommitted user work: `apps/cli/src/main.ts` (a new `sandbox code` command), `apps/cli/src/commands/code.ts`, and `docs/known-issues.md` (60 new lines, including the "`sandbox up` Re-Installs the Session Hooks Unconditionally" entry that Task 5 deletes). Tasks 5 and 6 edit `main.ts` and `known-issues.md`. **Ask the user** to commit or move that work before Task 5. Do not stage it with this plan's commits.
- First commit: `git add docs/superpowers/specs/2026-09-27-context-strategy-interface.md docs/superpowers/plans/2026-09-27-context-strategy-interface.md docs/context-strategies.md && git commit -m "docs: spec and plan for the context strategy interface"`.
- `feat/work-type-phase-gate` (worktree `.claude/worktrees/work-type-phases`) is **not** merged into `main`, and it edits step 5b (`phase_gate` in the manifest). If it merges before Task 2, rebase onto it, then rerun Task 1's `UPDATE_SNAPSHOT=1` step on the rebased tree **before** starting Task 2. The move in Task 2 stays verbatim and carries whatever 5b–6c contains at that point.
- PR boundaries (the spec's §6 wants one PR per step): Tasks 1–2 = PR 1 (no behaviour change), Tasks 3–5 = PR 2, Task 6 = PR 3, Tasks 7–8 = PR 4. Each boundary leaves `main` shippable.

## Global Constraints

- Existing workspaces (no `context_strategy` field) behave byte-for-byte as today. `strategy-jit-snapshot.test.mjs` from Task 1 must pass unchanged after every later task.
- Only `strategies/index.ts` imports `strategies/jit.ts` or `strategies/icm.ts`. No dispatch site outside `strategies/` contains the string literals `"jit"` or `"icm"`. Check with `grep -rn '"jit"\|"icm"' packages/sandbox-core/*.ts apps/cli/src/commands apps/mcp/tools.ts`. The only allowed hit is `workspace_prompts.ts`, which imports `STRATEGY_IDS` rather than hardcoding the ids.
- A field that is absent or empty means `jit`. An unknown value throws `SandboxError(..., "UNKNOWN_CONTEXT_STRATEGY")` listing `jit, icm`, and never falls back silently. The one exception is the two hook entry points (`notes context`, `hooks gate`). They swallow the error and do nothing, because a hook must never break a session or a tool call.
- `readContextStrategy` never prints. `notes context` stdout is injected into the agent's session, so it must not use `loadConfigFile`, which logs `[info] Loaded workspace config`.
- The `./sandbox` wrapper's `hooks gate` fast path (`apps/cli/sandbox:94-97` → `dist/lib/gate.js`) is untouched and stays JIT-only.
- ICM writes no `.claude/`, no `.sandbox/notes/`, and no `.sandbox/standards.json`. `BRIEF.md` is written only if it is absent. Nothing is ever written into an existing `stages/*/output/`.
- The ICM `CLAUDE.md` is ≤ 60 lines.
- Every `tsconfig`/`exports` change that makes `strategies/` build is in Task 2. `packages/sandbox-core/tsconfig.json` includes only `*.ts` today, so a subdirectory is silently not compiled until it is added there.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec (decided here, keep them)

1. **Tests are flat `packages/sandbox-core/strategy-*.test.mjs`**, not `__tests__/strategies/*.test.ts`. The core suite globs `*.test.mjs` in one directory. The `up` test is vitest in `apps/cli/src/lib/__tests__/`, beside `lifecycle_up_hooks.test.ts`.
2. **`checkSkills`/`syncSkills` do not move.** They already live in core (`workspace_skills.ts:269,314`), and MCP already imports them from there.
3. **`InitContext` has no `report` field.** The reporter is ambient (`withReporter`), and the moved code already calls `info`/`success`/`warn`. `repos` is `[name, branch]` (what `discoverRepos` returns), not `[name, path]`.
4. **`jit.check` returns one list:** `[...authoring, ...drift, manifestDrift?]`. As a result, the CLI prints the "lags" hint whenever that list is non-empty (today it prints only on drift), and the success line becomes `Context layer fresh (<id>).`. MCP `sandbox-skills` returns `{ drift: string[] }` for check and `{ wrote: string[] }` for sync. MCP `sandbox-hooks` returns `{ strategy }`.
5. **ICM stage contracts name standards by tier (`none` / `universal` / `all` active) rather than by domain.** A contract then cannot name an inactive domain, so the spec's "drop the row when inactive" holds by construction.
6. **The `_shared/standards.md` "Read" column is the module's own `path`** (set by `loadStandardsModules`). The loader supports both `<domain>/STANDARD.md` and flat `<key>.md` trees.
7. **Build order:** the ICM renderer (Tasks 3–4) lands before the field (Task 5), so that the registry test can assert `icm`.
8. **No harness cell.** `strategy-icm-init.test.mjs` asserts the exact ICM file set, and the JIT snapshot pins the exact JIT set. The spec's `find | sort` diff would duplicate both.
9. **`--prune-context` deletes only paths that are git-tracked and clean.** That is what git can restore. Untracked, ignored, modified, or non-git paths are kept with a warning. Paths the new strategy also owns (`CLAUDE.md`) are never leftovers.
10. **Open questions:** Q1 standards are pointers, rendered from the loader's paths. Q2 `icm.refresh` deletes managed hooks and logs each one. Q3 the ICM `CLAUDE.md` says `sandbox up` is safe and warns only about `init-workspace`, and keeps `docker restart`. Q4 `sb-tester-*` stays in `jit.init`.

## Review Focus

1. **An ICM workspace with no `starting_prompt`** gets a `BRIEF.md` that says to write the brief. It must not get an empty body under the heading. Task 3's "empty prompt" test pins this.
2. **An ICM workspace with no `feature` or no `services`** gets a restart sentence that points at `sandbox-context.md`. It must not get `` `docker restart -backend` ``. Task 3's "no services" test pins this.
3. **A free-text work type (`constructor`, ` Feature `)** gets the feature template. `Object.hasOwn` and trim/lowercase make this work, where `ICM_TEMPLATES[wt]` would return `Object.prototype.constructor`. Task 3's `templateFor` test pins this.
4. **A malformed `workspace.yml`** makes `readContextStrategy` return `jit` and print nothing, so `notes context` stays silent and `hooks gate` exits 0. Task 5's "malformed yaml" test pins this.
5. **`.claude/settings.json` holding only managed hooks** ends with `icm.refresh` deleting the file and the then-empty `.claude/` (spec goal 4). An unparseable `settings.json` is left untouched. Task 4's tests pin both.

---

# PR 1 — the move (no behaviour change)

### Task 1: Snapshot JIT init output on `main`

**Files:**
- Create: `packages/sandbox-core/strategy-jit-snapshot.test.mjs`
- Create: `packages/sandbox-core/strategy-jit.snapshot.json` (generated)

**Interfaces:**
- Consumes: `initWorkspace(args, workspaceRootOverride)` from `dist/workspace_init.js`; `withSandboxHome(fn, { config })` from `fixtures.mjs`; `collectingReporter`, `withReporter` from `dist/reporter.js`.
- Produces: a committed snapshot that Task 2 onward must match.

The fixture has `.sandbox/workspace.yml` and no `feature`. That makes `initWorkspace` skip step 8 (compose, slot, docker build), because `meta.FEATURE` is empty and `resolveInputs` applies no defaults.

- [ ] **Step 1: Write the test**

```js
// Every file JIT init writes, captured on `main` before the context-strategy
// move and asserted byte-for-byte after it (spec §5 test 5). Regenerate only
// when a JIT output change is intended: UPDATE_SNAPSHOT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";

const SNAPSHOT = path.join(import.meta.dirname, "strategy-jit.snapshot.json");
const REPO = path.resolve(import.meta.dirname, "..", "..");

function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

function seedStandards(dir) {
  fs.mkdirSync(path.join(dir, "comments"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "comments", "STANDARD.md"),
    "---\ndomain: comments\nuniversal: 1\napplies_to:\n  - \"**/*\"\nphase: [implement]\nsummary: Comments explain why.\n---\n\n# Comments\n",
  );
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ui", "STANDARD.md"),
    "---\ndomain: ui\napplies_to:\n  - \"**/*.tsx\"\nphase: [implement]\nsummary: UI rules.\n---\n\n# UI\n",
  );
}

test("jit init writes the same files, byte for byte", async () => {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "jit-snap-std-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jit-snap-ws-"));
  try {
    seedStandards(std);
    fs.mkdirSync(path.join(root, ".sandbox"));
    fs.writeFileSync(
      path.join(root, ".sandbox", "workspace.yml"),
      "task: Snapshot run\nwork_type: feature\nstarting_prompt: Add a health check.\n",
    );
    const files = await withSandboxHome(
      async (home) => {
        await withReporter(collectingReporter(), () => initWorkspace({}, root));
        const out = {};
        for (const rel of walk(root)) {
          out[rel] = fs
            .readFileSync(path.join(root, rel), "utf8")
            .replaceAll(root, "<ROOT>")
            .replaceAll(std, "<STD>")
            .replaceAll(home, "<HOME>")
            .replaceAll(REPO, "<REPO>")
            .replaceAll(os.homedir(), "<USERHOME>");
        }
        return out;
      },
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
    if (process.env.UPDATE_SNAPSHOT) {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(files, null, 2) + "\n");
    }
    assert.deepEqual(files, JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Generate the snapshot on `main`'s code**

Run: `cd packages/sandbox-core && npx tsc && UPDATE_SNAPSHOT=1 node --test strategy-jit-snapshot.test.mjs`
Expected: PASS. `strategy-jit.snapshot.json` now exists. Open it and confirm it has keys for `CLAUDE.md`, `.claude/settings.json`, `.sandbox/standards.json`, `.claude/agents/sb-researcher.md`, a `.sandbox/notes/*handoff*` file, and at least one `.claude/skills/sb-*/SKILL.md`. If any of these is missing, the fixture did not exercise that step. Stop and fix the fixture before continuing.

- [ ] **Step 3: Prove it is deterministic**

Run: `node --test strategy-jit-snapshot.test.mjs` twice, **without** `UPDATE_SNAPSHOT`.
Expected: PASS both times. If a run fails on a timestamp or random value, add a `.replace(/<pattern>/g, "<TS>")` for it in the normalisation chain, regenerate, and note the pattern in the commit message.

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox-core/strategy-jit-snapshot.test.mjs packages/sandbox-core/strategy-jit.snapshot.json
git commit -m "test(core): snapshot every file JIT init writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `strategies/` with `jit.ts` as a pure move; `initWorkspace` and `up` dispatch

**Files:**
- Create: `packages/sandbox-core/strategies/types.ts`, `strategies/index.ts`, `strategies/jit.ts`
- Modify: `packages/sandbox-core/tsconfig.json` (`include`), `packages/sandbox-core/package.json` (`exports`)
- Modify: `packages/sandbox-core/workspace_init.ts:697-~800` (move out `_LEGACY_HANDOFF_PLACEHOLDER`, `salvageLegacyHandoffNotes`, `seedStartingHandoff`) and `:902-977` (steps 5b–6c)
- Modify: `packages/sandbox-core/lifecycle.ts:57,133`
- Test: `strategy-jit-snapshot.test.mjs` (unchanged), `apps/cli/src/lib/__tests__/lifecycle_up_hooks.test.ts`, `hooks_gen.test.ts`, `standards_*.test.ts` (unchanged)

**Interfaces:**
- Produces (`strategies/types.ts`): `STRATEGY_IDS`, `StrategyId`, `InitContext`, `ContextStrategy`, exactly as below.
- Produces (`strategies/index.ts`): `strategyById(id: StrategyId): ContextStrategy`, `strategyFor(workspaceRoot: string): ContextStrategy`, and re-exports of the types and `STRATEGY_IDS`. Importable as `sandbox-core/strategies`.
- Produces (`strategies/jit.ts`): `export const jit: ContextStrategy`.

- [ ] **Step 1: Make `strategies/` build and export**

`packages/sandbox-core/tsconfig.json`: change `"include": ["*.ts"]` to `"include": ["*.ts", "strategies/*.ts"]`, and change the comment above it to:

```jsonc
  // Globs, not a list: an explicit one silently dropped `k8s.ts` and
  // `k8s_forwards.ts` from a build that still exited 0. Every .ts here and in
  // strategies/ is a source file — the tests are .mjs and dist/ is the outDir.
```

`packages/sandbox-core/package.json` `exports`: add `"./strategies": "./dist/strategies/index.js",` after `"./status"` (alphabetical).

- [ ] **Step 2: Write `strategies/types.ts`**

```ts
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

export const STRATEGY_IDS = ["jit"] as const;
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
  hasServiceMap: boolean;
  /** `args["config"]` — a workspace config path overriding .sandbox/workspace.yml. */
  configOverride: string | null;
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
```

- [ ] **Step 3: Write `strategies/jit.ts`**

First **cut** these three items from `workspace_init.ts` and paste them into `jit.ts` verbatim, below the imports: `const _LEGACY_HANDOFF_PLACEHOLDER` (`:697`), `function salvageLegacyHandoffNotes` (`:699-735`), and `function seedStartingHandoff` (from `/** Seed the workspace's first handoff note` at `:736` through the function's closing brace). Step 6 is their only caller, and leaving them in `workspace_init.ts` would make `jit.ts` import `workspace_init.ts`, which is a cycle.

Then write the rest of the file:

```ts
/**
 * The `jit` context strategy — docs/jit-context-system.md §5–6. What was
 * initWorkspace steps 5b–6c, moved verbatim: active standards + gate
 * manifest, notes + CLAUDE.md, sb-* skills, generated agents, hooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { buildTesterSpecs, writeWorkspaceAgents } from "../agent_gen.js";
import { resolvePresentArchetypes } from "../archetypes.js";
import { buildClaudeMd, buildStandardsRoutingSection } from "../claude_md.js";
import { loadArchetypes } from "../config.js";
import { main as gateMain, resetSessionState } from "../gate.js";
import { standardsDirPath, standardsDirProblem } from "../global_config.js";
import { writeWorkspaceHooks } from "../hooks_gen.js";
import { buildContext, listNotes, nextNoteNumber, noteFilename, notesDir } from "../notes.js";
import { info, success, warn } from "../reporter.js";
import {
  buildStandardsManifest,
  loadStandardsModules,
  resolveActiveStandards,
  validateServiceStandards,
  writeStandardsManifest,
} from "../standards.js";
import { WORK_TYPE_PHASES, loadConfigFile, loadSandboxServiceConfigs } from "../workspace_prompts.js";
import {
  checkSkills,
  checkStandardsManifest,
  syncSkills,
  writeWorkspaceSkills,
} from "../workspace_skills.js";
import type { ContextStrategy, InitContext } from "./types.js";

// <-- _LEGACY_HANDOFF_PLACEHOLDER, salvageLegacyHandoffNotes, seedStartingHandoff pasted here

function init(ctx: InitContext): void {
  const { workspaceRoot, workspaceName, repos, task, meta, inputs, hasServiceMap, configOverride } = ctx;
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");

  // 5b. Resolve the workspace's active standards (docs/jit-context-system.md §4.1).
  let standardsSection: string | null = null;
  const modules = loadStandardsModules();
  if (Object.keys(modules).length) {
    const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
    for (const err of validateServiceStandards(servicesConfig, modules)) {
      warn(err);
    }
    const workspaceConfig = loadConfigFile(workspaceRoot, configOverride);
    const repoNames = repos.map(([name]) => name);
    const localServices = (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s);
    const [active, notActive] = resolveActiveStandards(
      repoNames,
      servicesConfig,
      reposConfig,
      workspaceConfig,
      modules,
      localServices,
    );
    standardsSection = buildStandardsRoutingSection(active, notActive, modules, repoNames);
    info(`Standards routing: active = ${active.join(", ")}`);
    // PreToolUse standards gate manifest.
    writeStandardsManifest(workspaceRoot, buildStandardsManifest(active, modules));
  } else {
    // Not fatal — a workspace without standards still works — but it is a
    // materially degraded one (no routing table, no sb-*-standard skills, no
    // gate manifest), and it used to happen in silence.
    warn(
      standardsDirProblem() ||
        `no standard modules found in ${standardsDirPath()} — this workspace gets no ` +
          `standards routing, skills, or edit-time gate`,
    );
  }

  // 6. Write CLAUDE.md. The notes directory is created; legacy free-text Handoff
  // Notes content is salvaged first, then the starting prompt / work type is
  // seeded as the first handoff note if the workspace has none yet.
  fs.mkdirSync(notesDir(workspaceRoot), { recursive: true });
  salvageLegacyHandoffNotes(workspaceRoot, claudeMdPath);
  seedStartingHandoff(workspaceRoot, inputs["starting_prompt"] ?? "", inputs["work_type"] ?? "");
  const content = buildClaudeMd(
    workspaceName,
    workspaceRoot,
    repos,
    task,
    meta,
    hasServiceMap,
    standardsSection,
  );
  fs.writeFileSync(claudeMdPath, content);
  success(`Wrote ${claudeMdPath}`);

  // 6a. Projected sb-* skills into .claude/skills/.
  for (const skillPath of writeWorkspaceSkills(workspaceRoot)) {
    success(`Wrote ${skillPath}`);
  }

  // 6b. Generated subagents: sb-researcher plus one sb-tester-<archetype> per
  // archetype present.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = resolvePresentArchetypes(
    repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s),
    archetypes,
  );
  const testerSpecs = buildTesterSpecs(present, servicesConfig, archetypes);
  for (const agentPath of writeWorkspaceAgents(workspaceRoot, testerSpecs)) {
    success(`Wrote ${agentPath}`);
  }

  // 6c. SessionStart hook. Merges into settings.json, never clobbers.
  const hooksPath = writeWorkspaceHooks(workspaceRoot);
  success(`Wrote ${hooksPath}`);
}

export const jit: ContextStrategy = {
  id: "jit",
  init,
  refresh(workspaceRoot) {
    // init-workspace is otherwise the only writer, so a workspace created before
    // a hook-template change kept the stale hook until someone re-ran it by hand.
    // The merge is idempotent and never clobbers a hand-added entry.
    writeWorkspaceHooks(workspaceRoot);
  },
  check(workspaceRoot) {
    const { authoring, drift } = checkSkills(workspaceRoot);
    // After the projected-skill report, because resolving the manifest logs.
    const manifestDrift = checkStandardsManifest(workspaceRoot);
    return [...authoring, ...drift, ...(manifestDrift === null ? [] : [manifestDrift])];
  },
  sync(workspaceRoot) {
    const { written, manifestPath } = syncSkills(workspaceRoot);
    return { wrote: manifestPath === null ? written : [...written, manifestPath] };
  },
  sessionContext(workspaceRoot, payload) {
    const source = String(payload["source"] || "");
    // Standards gate (docs/jit-context-system.md §6):
    // compact/clear wipe the context, so delivered standards must re-gate.
    if (source === "compact" || source === "clear") {
      resetSessionState(workspaceRoot, String(payload["session_id"] || ""));
    }
    return buildContext(workspaceRoot, source) || null;
  },
  gate: gateMain,
  ownedPaths: () => [
    "CLAUDE.md",
    ".claude/settings.json",
    ".claude/skills/sb-*",
    ".claude/agents/sb-*",
    ".sandbox/notes",
    ".sandbox/standards.json",
    ".sandbox/.gate",
  ],
};
```

The 5b–6c bodies above are copied from `workspace_init.ts:902-977`. The only change is `(args["config"] as string | null) ?? null` → `configOverride`. If the file has drifted from this text (for example, the phase-gate branch merged), copy **the file's** current text and not this plan's.

- [ ] **Step 4: Write `strategies/index.ts`**

```ts
/**
 * The strategy registry. The only importer of `jit.ts` / `icm.ts`: every
 * dispatch site asks `strategyFor(workspaceRoot)` and never names a strategy.
 */

import { jit } from "./jit.js";
import type { ContextStrategy, StrategyId } from "./types.js";

export { STRATEGY_IDS } from "./types.js";
export type { ContextStrategy, InitContext, StrategyId } from "./types.js";

const REGISTRY: Record<StrategyId, ContextStrategy> = { jit };

export function strategyById(id: StrategyId): ContextStrategy {
  return REGISTRY[id];
}

/** The strategy that owns *workspaceRoot*'s context layer. */
export function strategyFor(_workspaceRoot: string): ContextStrategy {
  return REGISTRY.jit;
}
```

- [ ] **Step 5: Dispatch from `initWorkspace`**

In `workspace_init.ts`, replace everything from `// 5b. Resolve the workspace's active standards` through `success(\`Wrote ${hooksPath}\`);` (`:902-977`) with:

```ts
  // 5b–6c. The context layer — CLAUDE.md and everything the agent reads
  // beside it — belongs to the workspace's strategy (docs/context-strategies.md).
  strategyFor(workspaceRoot).init({
    workspaceRoot,
    workspaceName,
    repos,
    task,
    meta,
    inputs,
    hasServiceMap,
    configOverride: (args["config"] as string | null) ?? null,
  });

  // 6d needs the present archetypes whichever strategy ran.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = resolvePresentArchetypes(
    repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s),
    archetypes,
  );
```

Add `import { strategyFor } from "./strategies/index.js";`. Then drop the imports that are now unused. Run `cd packages/sandbox-core && npx tsc --noEmit --noUnusedLocals 2>&1 | grep workspace_init` and remove every name it reports as declared but never read. Expected leftovers include `buildTesterSpecs`, `writeWorkspaceAgents`, `buildClaudeMd`, `buildStandardsRoutingSection`, `writeWorkspaceHooks`, `writeWorkspaceSkills`, `WORK_TYPE_PHASES`, the `standards.js` names, `standardsDirProblem`, and the `notes.js` names. Remove only what `tsc` names.

- [ ] **Step 6: Dispatch from `up`**

In `lifecycle.ts`, replace `import { writeWorkspaceHooks } from "./hooks_gen.js";` (`:57`) with `import { strategyFor } from "./strategies/index.js";`, and replace the comment and call at `:130-133` with:

```ts
  // Each strategy repairs its own layer: jit re-merges its hooks (a workspace
  // created before a hook-template change otherwise keeps the stale one), icm
  // strips any a pre-strategy `up` installed.
  strategyFor(workspace).refresh(workspace);
```

- [ ] **Step 7: Run the snapshot and the untouched suites**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS, including `strategy-jit-snapshot.test.mjs` with the snapshot file unmodified (`git diff --exit-code packages/sandbox-core/strategy-jit.snapshot.json`).

Run: `cd ../../apps/cli && npx vitest run src/lib/__tests__/lifecycle_up_hooks.test.ts src/lib/__tests__/hooks_gen.test.ts src/lib/__tests__/standards_dir.test.ts src/lib/__tests__/standards_links.test.ts src/lib/__tests__/standards_missing.test.ts`
Expected: PASS with no test edits. `lifecycle_up_hooks` mocks `sandbox-core/config` with only `loadPorts`/`loadServices`, and `up` now pulls in `jit.ts`, which imports `loadArchetypes`. It is read only at call time, so this should pass. If vitest reports `No "loadArchetypes" export is defined on the "sandbox-core/config" mock`, add `loadArchetypes: () => ({})` to that mock. That is the only edit allowed.

Run: `cd .. && npx vitest run && cd ../mcp && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-core/strategies packages/sandbox-core/tsconfig.json packages/sandbox-core/package.json packages/sandbox-core/workspace_init.ts packages/sandbox-core/lifecycle.ts
git commit -m "refactor(core): move init steps 5b-6c into the jit context strategy

No output change: strategy-jit.snapshot.json is untouched.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# PR 2 — ICM, and the field that selects it

### Task 3: The ICM renderer (`feature` template)

**Files:**
- Create: `packages/sandbox-core/strategies/icm_templates.ts`, `packages/sandbox-core/strategies/icm.ts`
- Modify: `packages/sandbox-core/strategies/types.ts` (`STRATEGY_IDS`), `strategies/index.ts` (registry)
- Test: `packages/sandbox-core/strategy-icm-init.test.mjs`

**Interfaces:**
- Consumes: `InitContext`, `ContextStrategy` (Task 2); `loadStandardsModules`, `resolveActiveStandards`, `universalStandards`, `repoDirs` (`standards.ts`); `loadConfigFile`, `loadSandboxServiceConfigs`, `_INPUT_FIELDS` (`workspace_prompts.ts`); `standardsDirPath`, `standardsDirProblem` (`global_config.ts`).
- Produces: `templateFor(workType: string): Stage[]` plus the `Stage`, `Contract`, `IcmVars` types and `ICM_TEMPLATES` (from `icm_templates.ts`); `export const icm: ContextStrategy` (from `icm.ts`, with `refresh` a no-op until Task 4); `strategyById("icm")`.

- [ ] **Step 1: Write the failing test**

```js
// The icm strategy's init: the files icm-ws2 ran with, generated from
// InitContext alone, and the write-once rules that protect a run in progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { strategyById } from "./dist/strategies/index.js";
import { templateFor } from "./dist/strategies/icm_templates.js";

const PROMPT = "## Goal\n\nDocument the backend API.\n\n## Open questions\n\n1. UI or raw spec?";

function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

/** A workspace with one repo and a two-module standards tree; returns [root, ctx]. */
async function withIcmWorkspace(fn, { inputs = {}, meta = { FEATURE: "demo", SERVICES: "backend" } } = {}) {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "icm-std-"));
  fs.mkdirSync(path.join(std, "comments"));
  fs.writeFileSync(
    path.join(std, "comments", "STANDARD.md"),
    "---\ndomain: comments\nuniversal: 1\napplies_to:\n  - \"**/*\"\nsummary: why not what\n---\n\n# Comments\n",
  );
  fs.mkdirSync(path.join(std, "ui"));
  fs.writeFileSync(
    path.join(std, "ui", "STANDARD.md"),
    "---\ndomain: ui\napplies_to:\n  - \"**/*.tsx\"\nsummary: ui\n---\n\n# UI\n",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-ws-"));
  fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox"));
  const allInputs = { context_strategy: "icm", work_type: "feature", starting_prompt: PROMPT, feature: meta.FEATURE, services: meta.SERVICES, ...inputs };
  fs.writeFileSync(
    path.join(root, ".sandbox", "workspace.yml"),
    Object.entries(allInputs).filter(([, v]) => v).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n",
  );
  const ctx = {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: [["demo-repo", "me/demo"]],
    task: "OpenAPI docs",
    meta,
    inputs: allInputs,
    hasServiceMap: false,
    configOverride: null,
  };
  try {
    return await withSandboxHome(
      () => withReporter(collectingReporter(), async () => fn(root, ctx)),
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
}

const icm = strategyById("icm");

test("init writes the icm layer and nothing of jit's", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    const files = walk(root).filter((f) => !f.startsWith("demo-repo") && !f.startsWith(".sandbox"));
    assert.deepEqual(files, [
      "BRIEF.md",
      "CLAUDE.md",
      "CONTEXT.md",
      "_shared/standards.md",
      "stages/01_research/CONTEXT.md",
      "stages/01_research/output/.gitkeep",
      "stages/02_spec/CONTEXT.md",
      "stages/02_spec/output/.gitkeep",
      "stages/03_implement/CONTEXT.md",
      "stages/03_implement/output/.gitkeep",
      "stages/04_ship/CONTEXT.md",
      "stages/04_ship/output/.gitkeep",
    ]);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", "notes")));
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", "standards.json")));

    assert.ok(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8").endsWith(`\n${PROMPT}\n`));

    const standards = fs.readFileSync(path.join(root, "_shared", "standards.md"), "utf8");
    assert.match(standards, /^\| comments \| `.*comments\/STANDARD\.md` \| any code edit \|$/m);
    assert.match(standards, /^\| ponytail \| already loaded/m);
    assert.match(standards, /do not load\): ui\./);

    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    assert.ok(claude.split("\n").length <= 60, `CLAUDE.md is ${claude.split("\n").length} lines`);
    assert.match(claude, /`docker restart demo-backend`/);
    assert.match(claude, /`stages\/02_spec\/CONTEXT\.md`/);

    const implement = fs.readFileSync(path.join(root, "stages", "03_implement", "CONTEXT.md"), "utf8");
    assert.match(implement, /rows `comments`, `ponytail`/);
    assert.doesNotMatch(implement, /`ui`/);
    assert.match(implement, /never run `sandbox up`/i);
    for (const f of walk(root)) {
      if (f.endsWith(".md")) assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /undefined/, f);
    }
  });
});

test("rerunning init keeps an edited brief and a stage's output", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    fs.writeFileSync(path.join(root, "BRIEF.md"), "edited by a person\n");
    fs.writeFileSync(path.join(root, "stages", "01_research", "output", "x.md"), "artifact\n");
    fs.rmSync(path.join(root, "stages", "01_research", "output", ".gitkeep"));
    icm.init(ctx);
    assert.equal(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), "edited by a person\n");
    assert.equal(fs.readFileSync(path.join(root, "stages", "01_research", "output", "x.md"), "utf8"), "artifact\n");
    assert.ok(!fs.existsSync(path.join(root, "stages", "01_research", "output", ".gitkeep")));
  });
});

test("check is empty right after init, and sync repairs an edited contract", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    assert.deepEqual(icm.check(root), []);
    fs.writeFileSync(path.join(root, "stages", "02_spec", "CONTEXT.md"), "hand edit\n");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "hand edit\n");
    assert.deepEqual(icm.check(root), ["stages/02_spec/CONTEXT.md"]);
    assert.deepEqual(icm.sync(root), { wrote: ["stages/02_spec/CONTEXT.md"] });
    assert.deepEqual(icm.check(root), []);
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "hand edit\n");
  });
});

test("an empty starting prompt still gives the brief a body", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      assert.match(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), /No starting prompt was given/);
    },
    { inputs: { starting_prompt: "" } },
  );
});

test("no feature or services: the restart sentence points at sandbox-context.md", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.doesNotMatch(claude, /docker restart/);
      assert.match(claude, /as `\.sandbox\/sandbox-context\.md` describes/);
    },
    { meta: { FEATURE: "", SERVICES: "" } },
  );
});

test("templateFor falls back to feature for free text, and normalises case", () => {
  const feature = templateFor("feature").map((s) => s.name);
  assert.deepEqual(feature, ["research", "spec", "implement", "ship"]);
  assert.deepEqual(templateFor("constructor").map((s) => s.name), feature);
  assert.deepEqual(templateFor(" Feature ").map((s) => s.name), feature);
  assert.deepEqual(templateFor("").map((s) => s.name), feature);
});

test("sessionContext is null and gate is a no-op", () => {
  assert.equal(icm.sessionContext("/nonexistent", {}), null);
  assert.equal(icm.gate(), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-init.test.mjs`
Expected: FAIL. `strategyById("icm")` returns `undefined` and `icm_templates.js` is not found.

- [ ] **Step 3: Write `strategies/icm_templates.ts` (feature only)**

```ts
/**
 * ICM stage templates, keyed by work_type. Each stage is a contract the agent
 * reads by itself — the pipeline carries sequencing, not a hook. Generalised
 * from the hand-built ~/features/icm-ws2 after its run-2 fixes: a `decided`
 * status is the approval, reloads use `docker restart`, and the test command is
 * quoted from sandbox-context.md rather than restated.
 */

export interface IcmVars {
  /** Path from one stage dir to another stage's dir, by stage name: `../01_research`. */
  at(name: string): string;
  /** The code worktrees, as paths from a stage dir. */
  repos: string;
  /** How to reload running code without `sandbox`. */
  restart: string;
  /** This stage's standards Reference line, or "" — the renderer fills it. */
  standards: string;
}

export interface Contract {
  oneJob: string;
  inputs: string[];
  doNotLoad: string;
  process: string[];
  outputs: string[];
  humanCheck: string;
}

export interface Stage {
  name: string;
  /** Heading and CONTEXT.md "Job" cell. */
  job: string;
  /** CONTEXT.md "Output" cell. */
  writes: string;
  /** CONTEXT.md "Human check" cell. */
  check: string;
  /** CLAUDE.md route-table "If" cell; default "`<previous dir>` output approved". */
  enter?: string;
  /** Which _shared/standards.md rows the contract names. */
  standards: "none" | "universal" | "all";
  contract(v: IcmVars): Contract;
}

const RELOAD_RULE =
  "Never run `sandbox up`, `sandbox restart`, or `sandbox init-workspace` to reload — " +
  "they are slower, and init rewrites the stage contracts.";

const IMPLEMENT_STEPS = [
  "Confirm ponytail is active (see `_shared/standards.md`; invoke the skill only if it is not), then read the standards rows above. Restate the rule you are applying beside each edit.",
];

const TEST_STEP =
  "Run the test command exactly as `../../.sandbox/sandbox-context.md` states it. Redirect output to a file, trust the exit code, read back only the failing slice.";

const ship: Stage = {
  name: "ship",
  job: "acceptance walk and PR description",
  writes: "one commit per repo touched, `output/pr.md`",
  check: "approve, then open the PR",
  standards: "none",
  contract: () => ({
    oneJob:
      "One job: prove each acceptance criterion with a pointer to evidence, commit, and write the PR description. Opening the PR is the person's act.",
    inputs: [
      "Working (this run): `../../BRIEF.md` § Acceptance criteria",
      "Working (this run): `../*/output/` — every prior stage's artifacts",
      "Working (this run): `git status` and `git diff --stat` in each repo you touched",
    ],
    doNotLoad: "`_shared/standards.md` (no code is written here), source files, `.sandbox/`.",
    process: [
      "Walk every acceptance criterion in `BRIEF.md`. For each, write PASS or FAIL with the file and line in a prior `output/` that proves it. A FAIL routes back to the owning stage — do not fix it here.",
      "Commit the changes on the workspace branch with a message that names the change, not the stage.",
      "Write `output/pr.md`: title, summary, the test summary and proof from the previous stage's output, a one-line justification for any added dependency, and the acceptance table from step 1.",
    ],
    outputs: ["One commit per repo touched, on the workspace branch", "`output/pr.md`"],
    humanCheck:
      "Read `pr.md`. If every row is PASS, push and open the PR with `pr.md` as the body. If a row is FAIL, send the run back to the stage it names.",
  }),
};

const feature: Stage[] = [
  {
    name: "research",
    job: "inventory the code, surface decisions",
    writes: "`output/inventory.md`, `output/decisions.md`",
    check: "answer every open question in `decisions.md`",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: establish what the code the brief touches does today, and turn the brief's open questions into an editable decision sheet. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names — grep for call sites, don't read whole trees`,
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.sandbox/*.yml`, `docker-compose.yml`.",
      process: [
        "List what exists that the brief touches: entry points, routes or exports, data shapes, and the tests that cover them.",
        "Find the test command in `../../.sandbox/sandbox-context.md` and copy it verbatim — do not restate it from memory.",
        "Check what is already installed that could do the job before recommending anything new.",
        "Write `output/inventory.md`: steps 1–3.",
        "Write `output/decisions.md`: every open question in `BRIEF.md`, each as a heading with `status: proposed`, your recommended answer, and the evidence from steps 1–3. Leave the answer blank when only a person can give it (a ticket key, a preference).",
      ],
      outputs: ["`output/inventory.md`", "`output/decisions.md`"],
      humanCheck:
        "Open `output/decisions.md`. Edit each answer as needed and change its `status: proposed` to `status: decided`. The next stage must not start while any question is still `proposed`. When every question reads `decided`, that is the approval — the next session starts the next stage without asking for confirmation.",
    }),
  },
  {
    name: "spec",
    job: "write the spec for the change",
    writes: "`output/spec.md`, any checkable artifact in the repo",
    check: "the spec covers every acceptance criterion",
    enter:
      "every question in `stages/01_research/output/decisions.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "universal",
    contract: (v) => ({
      oneJob:
        "One job: turn the settled decisions into a spec precise enough that the next stage needs no judgment calls, and prove any machine-checkable part of it.",
      inputs: [
        `Working (this run): \`${v.at("research")}/output/inventory.md\``,
        `Working (this run): \`${v.at("research")}/output/decisions.md\` — every entry must read \`status: decided\`; if not, stop and route back to that stage's human check`,
        "Reference (every run): `../../BRIEF.md` § Acceptance criteria",
      ],
      doNotLoad:
        "source files already summarised in `inventory.md` (if it looks wrong, fix `inventory.md` and tell the person), `.sandbox/*.yml`, other stages.",
      process: [
        "Write `output/spec.md`: what changes, file by file; the interfaces or schemas added; the tests that will prove it; what is explicitly out of scope.",
        "If the change has a machine-checkable artifact (a schema, an API document, a migration), write it in the repo and validate it with a command that needs no new dependency. Record the exact command in `spec.md`.",
        "Map each acceptance criterion in `BRIEF.md` to the step or test in `spec.md` that satisfies it. A criterion with no mapping is a defect in this stage.",
      ],
      outputs: ["`output/spec.md`", "Any artifact from step 2, in the repo"],
      humanCheck: "Read `output/spec.md` against the brief. Edit it directly — the next stage builds whatever is on disk.",
    }),
  },
  {
    name: "implement",
    job: "build it and prove it",
    writes: "code diff, `output/verify.md`",
    check: "read the diff; tests green",
    standards: "all",
    contract: (v) => ({
      oneJob: "One job: make the changes `spec.md` lists, add the tests it names, and prove them against the running service.",
      inputs: [
        `Working (this run): \`${v.at("spec")}/output/spec.md\` and the files it names`,
        `Working (this run): \`${v.at("research")}/output/decisions.md\``,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports, test command",
      ],
      doNotLoad:
        "`BRIEF.md` (`decisions.md` and `spec.md` carry the settled scope), `inventory.md`, `.sandbox/*.yml`, `docker-compose.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "Make the changes `spec.md` lists, and only those. No new runtime dependency unless `decisions.md` justified one in a line.",
        "Add the tests `spec.md` names. Match the style of the nearest existing test; no new test framework.",
        TEST_STEP,
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} Then exercise the change against the published port from \`sandbox-context.md\` and capture the response.`,
        "Write `output/verify.md`: `git diff --stat` for each repo you touched, the test exit code and summary line, the reload-and-exercise output, and any deviation from `spec.md` with its reason.",
      ],
      outputs: ["Code changes, uncommitted — the next stage commits after the person reads the diff", "`output/verify.md`"],
      humanCheck: "Read the diff. Run the tests yourself. Edit the code in place if something is off — the next stage commits what is on disk.",
    }),
  },
  ship,
];

export const ICM_TEMPLATES: Record<string, Stage[]> = { feature };

/** The stage list for *workType*; free text and unknown types get `feature`. */
export function templateFor(workType: string): Stage[] {
  const wt = workType.trim().toLowerCase();
  return Object.hasOwn(ICM_TEMPLATES, wt) ? ICM_TEMPLATES[wt] : ICM_TEMPLATES["feature"];
}
```

- [ ] **Step 4: Write `strategies/icm.ts`**

```ts
/**
 * The `icm` context strategy: a staged-folder pipeline the agent walks by
 * itself (docs/context-strategies.md). Plain files only — no hooks, no notes,
 * no gate manifest. `CLAUDE.md` routes, `CONTEXT.md` shows the pipeline,
 * `BRIEF.md` is the operator's, `_shared/standards.md` points at the standards
 * tree, and each `stages/NN_<name>/CONTEXT.md` is one stage's contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { standardsDirPath, standardsDirProblem } from "../global_config.js";
import { info, success, warn } from "../reporter.js";
import {
  loadStandardsModules,
  repoDirs,
  resolveActiveStandards,
  universalStandards,
} from "../standards.js";
import { _INPUT_FIELDS, loadConfigFile, loadSandboxServiceConfigs } from "../workspace_prompts.js";
import { templateFor, type IcmVars, type Stage } from "./icm_templates.js";
import type { ContextStrategy, InitContext } from "./types.js";

const PONYTAIL_ROW =
  "| ponytail | already loaded: the ponytail plugin's SessionStart hook prints `PONYTAIL MODE ACTIVE` " +
  "in every session. Invoke the `ponytail` skill only if that line is missing from your session context " +
  "| any code edit |";

interface Resolved {
  active: string[];
  notActive: string[];
  modules: Record<string, Record<string, any>>;
}

function list(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter((x) => x);
}

function stageDirs(stages: Stage[]): string[] {
  return stages.map((s, i) => `${String(i + 1).padStart(2, "0")}_${s.name}`);
}

function vars(ctx: InitContext, stages: Stage[]): IcmVars {
  const dirs = stageDirs(stages);
  const feature = (ctx.meta["FEATURE"] ?? "").trim();
  const services = list(ctx.meta["SERVICES"]);
  const repos = ctx.repos.map(([name]) => name);
  return {
    at: (name) => `../${dirs[stages.findIndex((s) => s.name === name)]}`,
    repos: repos.length ? repos.map((r) => `\`../../${r}/\``).join(", ") : "the code worktrees in this workspace",
    // Container names follow docker-compose.feature.yml.njk: <feature>-<service>.
    restart:
      feature && services.length
        ? services.map((s) => `\`docker restart ${feature}-${s}\``).join(", ")
        : "restart whatever serves the change as `.sandbox/sandbox-context.md` describes",
    standards: "",
  };
}

// The same resolution jit's step 5b makes; the gate manifest is not written.
function resolveStandards(ctx: InitContext): Resolved {
  const modules = loadStandardsModules();
  if (!Object.keys(modules).length) {
    warn(standardsDirProblem() || `no standard modules found in ${standardsDirPath()} — _shared/standards.md lists none`);
    return { active: [], notActive: [], modules };
  }
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const [active, notActive] = resolveActiveStandards(
    ctx.repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    loadConfigFile(ctx.workspaceRoot, ctx.configOverride),
    modules,
    list(ctx.meta["SERVICES"]),
  );
  return { active, notActive, modules };
}

function appliesWhen(meta: Record<string, any>): string {
  const globs: string[] = Array.isArray(meta["applies_to"]) ? meta["applies_to"].map(String) : [];
  if (!globs.length || globs.includes("**/*")) return "any code edit";
  return "editing " + globs.map((g) => `\`${g}\``).join(", ");
}

function renderStandards(r: Resolved): string {
  const lines = [
    "# Coding standards (factory)",
    "",
    "Read from their one home, not copied. Load only the rows a stage's contract names.",
    "",
    "| Standard | Read | Applies when |",
    "|---|---|---|",
    ...r.active.map((d) => `| ${d} | \`${r.modules[d]["path"]}\` | ${appliesWhen(r.modules[d])} |`),
    PONYTAIL_ROW,
    "",
  ];
  if (r.notActive.length) {
    lines.push(`Not applicable to this workspace (do not load): ${r.notActive.join(", ")}.`, "");
  }
  lines.push(
    "Before writing code on a path a standard governs, restate the one rule you are applying in a line next to the edit — a rule read twenty tool calls ago no longer steers.",
    "",
  );
  return lines.join("\n");
}

function standardsRef(tier: Stage["standards"], r: Resolved): string {
  if (tier === "none") return "";
  const universal = universalStandards(r.modules);
  const rows = tier === "all" ? r.active : r.active.filter((d) => universal.includes(d));
  return `- Reference (every run): \`../../_shared/standards.md\` — rows ${[...rows, "ponytail"].map((d) => `\`${d}\``).join(", ")}`;
}

function renderContract(dir: string, stage: Stage, v: IcmVars): string {
  const c = stage.contract(v);
  return [
    `# ${dir} — ${stage.job}`,
    "",
    c.oneJob,
    "",
    "## Inputs",
    ...c.inputs.map((i) => `- ${i}`),
    ...(v.standards ? [v.standards] : []),
    "",
    `Do NOT load: ${c.doNotLoad}`,
    "",
    "## Process",
    ...c.process.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Outputs",
    ...c.outputs.map((o) => `- ${o}`),
    "",
    "## Human check",
    c.humanCheck,
    "",
  ].join("\n");
}

function renderClaudeMd(ctx: InitContext, stages: Stage[]): string {
  const dirs = stageDirs(stages);
  const v = vars(ctx, stages);
  return [
    `# Workspace: ${ctx.workspaceName}`,
    "",
    ctx.task,
    "",
    "Read this file, then `CONTEXT.md`, then only the one stage `CONTEXT.md` the routing table sends you to. Nothing else up front.",
    "",
    "## Where things live",
    "",
    "| Path | Holds |",
    "|---|---|",
    "| `BRIEF.md` | the run's input: goal, acceptance criteria, open questions |",
    "| `CONTEXT.md` | the pipeline in one screen |",
    "| `stages/NN_*/` | one stage each: `CONTEXT.md` (contract) + `output/` (this run's artifacts) |",
    "| `_shared/` | factory: the coding standards, same every run |",
    ...ctx.repos.map(([name, branch]) => `| \`${name}/\` | code worktree${branch ? `, branch \`${branch}\`` : ""} |`),
    "| `.sandbox/sandbox-context.md` | generated infra facts: ports, container names, test command |",
    "| `.sandbox/*.yml`, `docker-compose.yml`, `.env` | generated by `sandbox`; do not hand-edit |",
    "",
    `\`sandbox up\` is safe here. Do not rerun \`sandbox init-workspace\` unless you mean to regenerate this file and the stage contracts. To reload code after an edit, ${v.restart}.`,
    "",
    "## Route by what just happened",
    "",
    "| If | Go to | Stop when |",
    "|---|---|---|",
    ...stages.map(
      (s, i) =>
        `| ${i === 0 ? "starting the run" : (s.enter ?? `\`${dirs[i - 1]}\` output approved`)} | \`stages/${dirs[i]}/CONTEXT.md\` | a person has read \`output/\` |`,
    ),
    "| asked for status | `ls stages/*/output/` | report which stages hold artifacts |",
    "| containers / ports / routing broken | `.sandbox/sandbox-context.md` | — |",
    "",
    "## The one rule",
    "",
    "Nothing moves to the next stage until a person has read — and edited if needed — the previous stage's `output/`. The next stage reads whatever is there. The person's edit (a `decided` status, or a \"proceed\" after a gate) is the approval; never ask them to confirm it a second time.",
    "",
  ].join("\n");
}

function renderPipeline(ctx: InitContext, stages: Stage[]): string {
  const dirs = stageDirs(stages);
  return [
    `# ${ctx.workspaceName} — the pipeline`,
    "",
    "| Stage | Job | Output | Human check |",
    "|---|---|---|---|",
    ...stages.map((s, i) => `| \`${dirs[i]}\` | ${s.job} | ${s.writes} | ${s.check} |`),
    "",
    "Factory (stable, every run): `_shared/standards.md`",
    "Product (new each run): each stage's `output/`, plus the commits in the code worktrees",
    "",
    "Status is whatever exists: a stage is COMPLETE when its `output/` holds a real artifact — `.gitkeep` does not count.",
    "",
  ].join("\n");
}

function renderBrief(ctx: InitContext): string {
  const prompt = (ctx.inputs["starting_prompt"] ?? "").trim();
  return [
    "---",
    "source: .sandbox/workspace.yml (starting_prompt)",
    "---",
    "",
    `# Brief: ${ctx.task}`,
    "",
    prompt ||
      "_No starting prompt was given. Write the goal, acceptance criteria and open questions here before starting the first stage._",
    "",
  ].join("\n");
}

/** The regenerable files — what `check` diffs and `sync` rewrites. */
function render(ctx: InitContext): Record<string, string> {
  const stages = templateFor(ctx.inputs["work_type"] ?? "");
  const dirs = stageDirs(stages);
  const r = resolveStandards(ctx);
  const base = vars(ctx, stages);
  const files: Record<string, string> = { "_shared/standards.md": renderStandards(r) };
  stages.forEach((stage, i) => {
    files[`stages/${dirs[i]}/CONTEXT.md`] = renderContract(dirs[i], stage, {
      ...base,
      standards: standardsRef(stage.standards, r),
    });
  });
  return files;
}

/** Rebuild what `render` needs from the workspace on disk, for check/sync. */
function contextFromDisk(root: string): InitContext {
  const cfg = loadConfigFile(root, null);
  const inputs: Record<string, string> = {};
  for (const [, , field] of _INPUT_FIELDS) {
    const value = cfg[field];
    if (value !== undefined && value !== null) {
      inputs[field] = Array.isArray(value) ? value.map(String).join(",") : String(value);
    }
  }
  return {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: repoDirs(root).map((d): [string, string] => [path.basename(d), ""]),
    task: inputs["task"] ?? "",
    meta: { FEATURE: inputs["feature"] ?? "", SERVICES: inputs["services"] ?? "" },
    inputs,
    hasServiceMap: false,
    configOverride: null,
  };
}

function writeRel(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function drifted(root: string): Array<[string, string]> {
  return Object.entries(render(contextFromDisk(root))).filter(([rel, body]) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8") !== body;
    } catch {
      return true;
    }
  });
}

function init(ctx: InitContext): void {
  const root = ctx.workspaceRoot;
  const stages = templateFor(ctx.inputs["work_type"] ?? "");
  const files: Record<string, string> = {
    "CLAUDE.md": renderClaudeMd(ctx, stages),
    "CONTEXT.md": renderPipeline(ctx, stages),
    ...render(ctx),
  };
  // The brief is the operator's once written — same rule as seedStartingHandoff.
  if (!fs.existsSync(path.join(root, "BRIEF.md"))) {
    files["BRIEF.md"] = renderBrief(ctx);
  }
  for (const [rel, body] of Object.entries(files)) {
    writeRel(root, rel, body);
    success(`Wrote ${rel}`);
  }
  // Never write into an existing output/: it holds a run in progress.
  for (const dir of stageDirs(stages)) {
    const out = path.join(root, "stages", dir, "output");
    if (!fs.existsSync(out)) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, ".gitkeep"), "");
    }
  }
}

export const icm: ContextStrategy = {
  id: "icm",
  init,
  refresh() {},
  check: (root) => drifted(root).map(([rel]) => rel),
  sync(root) {
    const wrote: string[] = [];
    for (const [rel, body] of drifted(root)) {
      writeRel(root, rel, body);
      info(`wrote ${rel}`);
      wrote.push(rel);
    }
    return { wrote };
  },
  // Re-injection is the route table the agent reads by itself; there is no hook.
  sessionContext: () => null,
  gate() {},
  ownedPaths: () => ["CLAUDE.md", "CONTEXT.md", "BRIEF.md", "_shared", "stages"],
};
```

- [ ] **Step 5: Register `icm`**

`strategies/types.ts`: `export const STRATEGY_IDS = ["jit", "icm"] as const;`

`strategies/index.ts`: add `import { icm } from "./icm.js";` and change the registry to `const REGISTRY: Record<StrategyId, ContextStrategy> = { jit, icm };`. `strategyFor` still returns `REGISTRY.jit` (Task 5 reads the field).

- [ ] **Step 6: Run the tests**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-init.test.mjs strategy-jit-snapshot.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/strategies packages/sandbox-core/strategy-icm-init.test.mjs
git commit -m "feat(core): icm context strategy renders the staged-folder pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `icm.refresh` strips JIT hooks and gate state

**Files:**
- Modify: `packages/sandbox-core/hooks_gen.ts` (add `removeWorkspaceHooks` after `writeWorkspaceHooks`)
- Modify: `packages/sandbox-core/strategies/icm.ts` (`refresh`)
- Test: `packages/sandbox-core/strategy-icm-refresh.test.mjs`

**Interfaces:**
- Produces: `removeWorkspaceHooks(workspaceRoot: string): string[]` in `hooks_gen.ts`. It returns the removed hook commands.
- `icm.refresh(workspaceRoot)` removes managed hooks (logging each one) and `.sandbox/.gate/`.

- [ ] **Step 1: Write the failing test**

```js
// icm.refresh is the repair path for a workspace a pre-strategy `up` polluted
// with JIT hooks. It removes exactly the sandbox-managed entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { PRE_TOOL_USE_GATE_COMMAND, SESSION_START_COMMAND } from "./dist/hooks_gen.js";
import { strategyById } from "./dist/strategies/index.js";

const icm = strategyById("icm");
const HAND = { hooks: [{ type: "command", command: "echo mine" }] };

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-refresh-"));
  fs.mkdirSync(path.join(root, ".claude"));
  fs.mkdirSync(path.join(root, ".sandbox", ".gate"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sandbox", ".gate", "s.json"), "{}");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return root;
}

async function refresh(root) {
  const c = collectingReporter();
  await withReporter(c, async () => icm.refresh(root));
  return c.text();
}

test("keeps the hand-added hook, drops the managed ones and .gate", async () => {
  const root = workspace({
    hooks: {
      SessionStart: [HAND, { hooks: [{ type: "command", command: SESSION_START_COMMAND }] }],
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: PRE_TOOL_USE_GATE_COMMAND }] }],
    },
  });
  try {
    const log = await refresh(root);
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings, { hooks: { SessionStart: [HAND] } });
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", ".gate")));
    assert.match(log, /sandbox notes context/);
    assert.match(log, /sandbox hooks gate/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only managed hooks: settings.json and the empty .claude/ go", async () => {
  const root = workspace({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: SESSION_START_COMMAND }] }] } });
  try {
    await refresh(root);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unparseable settings.json is left untouched", async () => {
  const root = workspace("{ not json");
  try {
    await refresh(root);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace with no .claude/ stays without one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-refresh-"));
  try {
    await refresh(root);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-refresh.test.mjs`
Expected: FAIL on the first two tests (settings unchanged, `.gate` present).

- [ ] **Step 3: Add `removeWorkspaceHooks` to `hooks_gen.ts`**

```ts
/**
 * Remove every sandbox-managed hook entry from `.claude/settings.json`,
 * keeping hand-added ones. When nothing else is left, the file goes too, and
 * `.claude/` if that empties it. Returns the removed commands. Unparseable
 * JSON or an unexpected shape is left untouched — the writer's doctrine.
 */
export function removeWorkspaceHooks(workspaceRoot: string): string[] {
  const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = settings?.["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return [];
  }
  const removed: string[] = [];
  for (const [event, marker] of [
    ["SessionStart", _HOOK_MARKER],
    ["PreToolUse", _GATE_MARKER],
  ] as const) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !_isManaged(entry, marker));
    for (const entry of entries) {
      if (!kept.includes(entry)) removed.push(...entry["hooks"].map((h: any) => String(h["command"])));
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed.length) {
    return [];
  }
  if (!Object.keys(hooks).length) delete settings["hooks"];
  if (Object.keys(settings).length) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } else {
    fs.rmSync(settingsPath);
    try {
      fs.rmdirSync(path.dirname(settingsPath));
    } catch {
      // .claude/ holds something else — keep it
    }
  }
  return removed;
}
```

- [ ] **Step 4: Implement `icm.refresh`**

In `icm.ts`, add `import { removeWorkspaceHooks } from "../hooks_gen.js";` and replace `refresh() {},` with:

```ts
  // The repair path for a workspace whose pre-strategy `up` installed the JIT
  // hooks. `_isManaged` is exact, so hand-added hooks survive.
  refresh(root) {
    for (const command of removeWorkspaceHooks(root)) {
      info(`Removed JIT hook from .claude/settings.json: ${command}`);
    }
    const gateDir = path.join(root, ".sandbox", ".gate");
    if (fs.existsSync(gateDir)) {
      fs.rmSync(gateDir, { recursive: true, force: true });
      info("Removed .sandbox/.gate/");
    }
  },
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-refresh.test.mjs strategy-icm-init.test.mjs`
Expected: PASS. Also run `cd ../../apps/cli && npx vitest run src/lib/__tests__/hooks_gen.test.ts`: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/hooks_gen.ts packages/sandbox-core/strategies/icm.ts packages/sandbox-core/strategy-icm-refresh.test.mjs
git commit -m "feat(core): icm refresh strips JIT-managed hooks and gate state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: The `context_strategy` field selects the strategy

**Files:**
- Modify: `packages/sandbox-core/strategies/index.ts` (`parseStrategyId`, `readContextStrategy`, `strategyFor`)
- Modify: `packages/sandbox-core/workspace_prompts.ts:107-118` (`_INPUT_FIELDS`) and `:328-338` (new `PromptSpec` after `work_type`)
- Modify: `packages/sandbox-core/workspace_init.ts` (strategy from inputs, captured before 2a)
- Modify: `apps/cli/infra/schemas/workspace.schema.json` (property after `work_type`)
- Modify: `apps/cli/src/main.ts` (`--context-strategy` on `workspace` ≈`:500`/`:538` and `init-workspace` ≈`:676`/`:714`)
- Modify: `docs/known-issues.md` (delete the "`sandbox up` Re-Installs the Session Hooks Unconditionally" entry)
- Test: `packages/sandbox-core/strategy-registry.test.mjs`, `packages/sandbox-core/workspace_prompts.test.mjs`, `apps/cli/src/lib/__tests__/lifecycle_up_strategy.test.ts`

**Interfaces:**
- Consumes: `STRATEGY_IDS`, `strategyById` (Tasks 2–3); `_WORKSPACE_CONFIG_NAMES`, `loadWorkspaceConfig`, `expandUserPath` (`workspace_prompts.ts`); `SandboxError` (`errors.ts`).
- Produces: `parseStrategyId(value: unknown): StrategyId`, `readContextStrategy(workspaceRoot: string): StrategyId`, and a `strategyFor(workspaceRoot)` that reads the field. `initWorkspace` exposes a local `previous: StrategyId | null`, which Task 8 uses.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/strategy-registry.test.mjs`:

```js
// context_strategy → strategy. Absent means jit; unknown throws; a malformed
// workspace.yml reads as jit and prints nothing (notes context feeds a hook).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { STRATEGY_IDS, readContextStrategy, strategyFor } from "./dist/strategies/index.js";

function ws(yml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-reg-"));
  fs.mkdirSync(path.join(root, ".sandbox"));
  if (yml !== null) fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), yml);
  return root;
}

test("no workspace.yml, or no field → jit", () => {
  assert.equal(readContextStrategy(ws(null)), "jit");
  assert.equal(readContextStrategy(ws("feature: demo\n")), "jit");
  assert.equal(readContextStrategy(ws("context_strategy: ''\n")), "jit");
});

test("icm → the icm strategy", () => {
  const root = ws("context_strategy: icm\n");
  assert.equal(readContextStrategy(root), "icm");
  assert.equal(strategyFor(root).id, "icm");
});

test("an unknown value throws, naming the choices", () => {
  assert.throws(() => readContextStrategy(ws("context_strategy: foo\n")), (err) => {
    assert.equal(err.code, "UNKNOWN_CONTEXT_STRATEGY");
    assert.match(err.message, /'foo'.*jit, icm/);
    return true;
  });
});

test("malformed yaml reads as jit and prints nothing", async () => {
  const c = collectingReporter();
  const id = await withReporter(c, async () => readContextStrategy(ws("context_strategy: [\n")));
  assert.equal(id, "jit");
  assert.equal(c.text(), "");
});

test("the workspace schema's enum is the registry", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "..", "apps", "cli", "infra", "schemas", "workspace.schema.json"), "utf8"),
  );
  assert.deepEqual(schema.properties.context_strategy.enum, [...STRATEGY_IDS]);
});
```

`packages/sandbox-core/workspace_prompts.test.mjs`: in the first test's expected key list, insert `"context_strategy",` right after `"work_type",`. Then add, after the "spec converts to a form schema" test:

```js
test("context_strategy is an optional select defaulting to jit", () => {
  const spec = computePromptSpec({}, root);
  const prompt = spec.prompts.find((p) => p.key === "context_strategy");
  assert.equal(prompt.default, "jit");
  assert.equal(prompt.accept_empty, true);
  const { schema } = buildFormSchema(spec);
  assert.ok(!schema.required.includes("context_strategy"));
});
```

`apps/cli/src/lib/__tests__/lifecycle_up_strategy.test.ts` has the same mocks as `lifecycle_up_hooks.test.ts`, so copy its `vi.mock` block verbatim:

```ts
/**
 * `up` used to re-install the JIT hooks into every workspace, including an ICM
 * one (known-issues, "`sandbox up` Re-Installs the Session Hooks
 * Unconditionally"). It now calls the workspace's strategy's refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SESSION_START_COMMAND } from "sandbox-core/hooks_gen";
import type { Reporter } from "sandbox-core/reporter";
import { withReporter } from "sandbox-core/reporter";

// <-- the vi.mock(...) block from lifecycle_up_hooks.test.ts, verbatim

import { up } from "sandbox-core/lifecycle";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-strategy-"));
  fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(root, ".env"), "SANDBOX_SLOT=3\nSERVICES=\n");
  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), "context_strategy: icm\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up in an icm workspace", () => {
  it("leaves .claude/ absent", async () => {
    await withReporter(quiet, () => up("demo", root));
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);
  });

  it("heals a workspace a pre-strategy up polluted", async () => {
    const hand = { hooks: [{ type: "command", command: "echo mine" }] };
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [hand, { hooks: [{ type: "command", command: SESSION_START_COMMAND }] }] } }),
    );
    await withReporter(quiet, () => up("demo", root));
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(settings).toEqual({ hooks: { SessionStart: [hand] } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-registry.test.mjs workspace_prompts.test.mjs`
Expected: FAIL. `readContextStrategy` is not exported, the schema has no `context_strategy`, and the prompt key list is missing it.

- [ ] **Step 3: Read the field in `strategies/index.ts`**

Add these imports: `import * as fs from "node:fs";`, `import * as path from "node:path";`, `import { SandboxError } from "../errors.js";`, `import { _WORKSPACE_CONFIG_NAMES, expandUserPath, loadWorkspaceConfig } from "../workspace_prompts.js";`, and `import { STRATEGY_IDS } from "./types.js";`. Keep the `export { STRATEGY_IDS }` re-export. Replace `strategyFor` with:

```ts
/** Absent or blank → jit. Anything else must name a registered strategy. */
export function parseStrategyId(value: unknown): StrategyId {
  const id = value === undefined || value === null ? "" : String(value).trim();
  if (!id) return "jit";
  if ((STRATEGY_IDS as readonly string[]).includes(id)) return id as StrategyId;
  throw new SandboxError(
    `Unknown context_strategy '${id}' in workspace.yml — expected one of: ${STRATEGY_IDS.join(", ")}`,
    "UNKNOWN_CONTEXT_STRATEGY",
  );
}

/**
 * The workspace's `context_strategy`. Reads the config files itself rather than
 * through `loadConfigFile`, which logs: `notes context` stdout is injected into
 * the session. Same search order; an unreadable file reads as jit, as
 * loadConfigFile treats it as empty.
 */
export function readContextStrategy(workspaceRoot: string): StrategyId {
  const candidates: string[] = [];
  const envOverride = process.env["SANDBOX_WORKSPACE_CONFIG"];
  if (envOverride) candidates.push(expandUserPath(envOverride));
  for (const name of _WORKSPACE_CONFIG_NAMES) candidates.push(path.join(workspaceRoot, ".sandbox", name));
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let data: any;
    try {
      data = loadWorkspaceConfig(p);
    } catch {
      return "jit";
    }
    const isMapping = typeof data === "object" && data !== null && !Array.isArray(data);
    return parseStrategyId(isMapping ? data["context_strategy"] : undefined);
  }
  return "jit";
}

/** The strategy that owns *workspaceRoot*'s context layer. */
export function strategyFor(workspaceRoot: string): ContextStrategy {
  return REGISTRY[readContextStrategy(workspaceRoot)];
}
```

- [ ] **Step 4: Plumb the field**

`workspace_prompts.ts` `_INPUT_FIELDS`: add `["context_strategy", "SANDBOX_CONTEXT_STRATEGY", "context_strategy"],` after the `work_type` row. Add `import { STRATEGY_IDS } from "./strategies/types.js";`. `types.ts` has no imports, so this closes no cycle. Add this entry to `_WIZARD_PROMPTS` directly after the `work_type` entry:

```ts
  {
    key: "context_strategy",
    label: "Context strategy",
    help:
      "Which context layer init-workspace generates: jit (sb-* skills, hooks, notes) " +
      "or icm (staged folders the agent walks by itself).",
    pattern: "^(" + STRATEGY_IDS.join("|") + ")$",
    defaultFn: () => "jit",
    choicesFn: () => [...STRATEGY_IDS],
  },
```

`apps/cli/infra/schemas/workspace.schema.json`: after the `work_type` property, add:

```json
    "context_strategy": {
      "type": "string",
      "enum": ["jit", "icm"],
      "description": "Which context layer init-workspace generates and up refreshes."
    },
```

`apps/cli/src/main.ts`, in **both** the `workspace` and `init-workspace` specs: add the option below after the `--work-type` option, and add `context_strategy: o.contextStrategy ?? null,` after `work_type: o.workType ?? null,` in each `namespace`.

```ts
        .addOption(
          new Option(
            "--context-strategy <id>",
            "Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). " +
              "(env: SANDBOX_CONTEXT_STRATEGY; config: context_strategy).",
          ).choices(["jit", "icm"]),
        )
```

- [ ] **Step 5: `initWorkspace` takes the strategy from its inputs**

In `workspace_init.ts`, directly after `const inputs = resolveInputs(args, workspaceRoot);`, add:

```ts
  // The layer this run writes, validated before 2a persists it, and the layer
  // the workspace had before — 2a overwrites that value (§3.6's "previous").
  const strategy = strategyById(parseStrategyId(inputs["context_strategy"]));
  let previous: StrategyId | null;
  try {
    previous = readContextStrategy(workspaceRoot);
  } catch {
    previous = null;
  }
```

Change the Task 2 call `strategyFor(workspaceRoot).init({...})` to `strategy.init({...})`. Update the import to `import { parseStrategyId, readContextStrategy, strategyById, type StrategyId } from "./strategies/index.js";`. `previous` stays unread until Task 8. `tsc` does not flag it because `noUnusedLocals` is off.

- [ ] **Step 6: Delete the known issue**

In `docs/known-issues.md`, delete the whole "`sandbox up` Re-Installs the Session Hooks Unconditionally" entry, from its heading to the next heading. The docs describe current state only.

- [ ] **Step 7: Run the tests**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS, including the snapshot. `workspace.yml` now round-trips no `context_strategy` for the jit fixture, because `resolveInputs` drops empty values.

Run: `cd ../../apps/cli && npx vitest run && npx tsc --noEmit`
Expected: PASS, including `lifecycle_up_strategy.test.ts`.

Run: `node apps/cli/dist/main.js init-workspace --print-prompts 2>/dev/null | grep -c context_strategy` after `npm run build` at the repo root.
Expected: `1` or more.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-core/strategies/index.ts packages/sandbox-core/workspace_prompts.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/strategy-registry.test.mjs packages/sandbox-core/workspace_prompts.test.mjs apps/cli/infra/schemas/workspace.schema.json apps/cli/src/main.ts apps/cli/src/lib/__tests__/lifecycle_up_strategy.test.ts docs/known-issues.md
git commit -m "feat: context_strategy in workspace.yml selects jit or icm

up now refreshes the workspace's own layer instead of always re-installing
the JIT hooks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

When staging `main.ts`, use `git add -p apps/cli/src/main.ts` if the user's `sandbox code` WIP is still uncommitted.

---

# PR 3 — CLI and MCP dispatch

### Task 6: `skills`, `notes context`, `hooks gate` and the two MCP tools dispatch; docs

**Files:**
- Modify: `apps/cli/src/commands/skills.ts`, `apps/cli/src/commands/notes.ts:214-235`, `apps/cli/src/commands/hooks.ts`
- Modify: `apps/mcp/tools.ts:44` (import), `:470-492` (`sandbox-skills`), `:505-520` (`sandbox-hooks`)
- Modify: `docs/jit-context-system.md` §5 (`:203`) and §11 (`:467`), `docs/context-strategies.md` (status line)
- Test: `apps/cli/src/commands/__tests__/strategy_commands.test.ts`, `packages/sandbox-core/strategy-notes-absent.test.mjs`

**Interfaces:**
- Consumes: `strategyFor(workspaceRoot)` from `sandbox-core/strategies`; `ContextStrategy.check/sync/sessionContext/gate/refresh`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/commands/__tests__/strategy_commands.test.ts`:

```ts
/**
 * In an icm workspace the JIT commands dispatch to icm: `skills check` reports
 * a fresh layer and exits 0, `hooks gate` prints nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "sandbox-core/reporter";
import { strategyFor } from "sandbox-core/strategies";

import { run as hooks } from "../hooks.js";
import { run as skills } from "../skills.js";

let root: string;
let home: string;
let prevCfg: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-home-"));
  fs.writeFileSync(path.join(home, "config.yaml"), `version: 1\noverrides:\n  standards_dir: ${path.join(home, "none")}\n`);
  fs.writeFileSync(path.join(home, "services.yaml"), "services: {}\n");
  prevCfg = process.env.SANDBOX_CONFIG_FILE;
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");

  root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-ws-"));
  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), "context_strategy: icm\nwork_type: feature\n");
  strategyFor(root).init({
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: [],
    task: "demo",
    meta: { FEATURE: "", SERVICES: "" },
    inputs: { context_strategy: "icm", work_type: "feature" },
    hasServiceMap: false,
    configOverride: null,
  });
  vi.spyOn(process, "cwd").mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevCfg === undefined) delete process.env.SANDBOX_CONFIG_FILE;
  else process.env.SANDBOX_CONFIG_FILE = prevCfg;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("JIT commands in an icm workspace", () => {
  it("skills check reports a fresh icm layer and does not exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const c = collectingReporter();
    await withReporter(c, () => skills({ action: "check" }));
    expect(exit).not.toHaveBeenCalled();
    expect(c.text()).toContain("Context layer fresh (icm)");
  });

  it("hooks gate prints nothing", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    await hooks({ action: "gate" });
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
```

`packages/sandbox-core/strategy-notes-absent.test.mjs` (spec §3.5: `down` needs no branch):

```js
// `down`'s teardownNotes reads these three; an icm workspace has no
// .sandbox/notes, so each must come back empty rather than throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { reconcileGraduating } from "./dist/graduate.js";
import { latestHandoff, openDecisions } from "./dist/notes.js";

test("no notes dir: no handoff, no decisions, nothing graduated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-absent-"));
  try {
    assert.equal(latestHandoff(root), null);
    assert.deepEqual(openDecisions(root), []);
    assert.deepEqual(reconcileGraduating(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify**

Run: `npm run build -w sandbox-core && cd apps/cli && npx vitest run src/commands/__tests__/strategy_commands.test.ts`
Expected: FAIL. `skills check` runs the JIT check (every `sb-*` skill reported missing), so `process.exit(1)` fires.

Run: `cd ../../packages/sandbox-core && node --test strategy-notes-absent.test.mjs`
Expected: PASS already. It pins the behaviour. If it fails, stop and report: the spec's "`down` needs no branch" is wrong.

- [ ] **Step 3: `skills.ts` dispatches**

Replace the imports and `run` in `apps/cli/src/commands/skills.ts`. In the header comment, change the first paragraph to "Freshness control for the workspace's context layer: `check` and `sync` are the workspace strategy's (`sandbox-core/strategies`). For jit that is the sb-* skills projected into `.claude/skills/` plus the gate manifest; for icm, `_shared/standards.md` and the stage contracts."

```ts
import { findWorkspaceRoot } from "sandbox-core/gate";
import { strategyFor } from "sandbox-core/strategies";

import { Colors, error, success } from "../lib/config.js";

function printDrift(entry: string): void {
  console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const workspace = findWorkspaceRoot(process.cwd());
  if (workspace === null) {
    error("Not inside a sandbox workspace (no .sandbox/ directory found above CWD).");
    process.exit(1);
  }
  const strategy = strategyFor(workspace);

  if (args.action === "sync") {
    strategy.sync(workspace);
    return;
  }

  const drift = strategy.check(workspace);
  for (const entry of drift) {
    printDrift(entry);
  }
  if (drift.length) {
    console.log(
      `${Colors.YELLOW}Context layer lags the sandbox repo — run ` +
        "`sandbox skills sync` (or `sandbox init-workspace`) to refresh." +
        `${Colors.RESET}`,
    );
    process.exit(1);
  }
  success(`Context layer fresh (${strategy.id}).`);
}
```

- [ ] **Step 4: `notes.ts` context dispatches**

In `run`, replace the body of the `try` block (from `const workspace = findWorkspaceRoot(...)` through the `process.stdout.write(context)` block) with:

```ts
    const workspace = findWorkspaceRoot(process.cwd());
    if (workspace === null) {
      return;
    }
    const context = strategyFor(workspace).sessionContext(workspace, hookPayload());
    if (context) {
      process.stdout.write(context);
    }
```

Keep the surrounding `try { ... } catch { return; }`: an `UNKNOWN_CONTEXT_STRATEGY` lands there and the hook stays silent. Add `import { strategyFor } from "sandbox-core/strategies";`. Remove `import { resetSessionState } from "sandbox-core/gate";`, and drop `buildContext` from the `sandbox-core/notes` import. `openDecisions` and `Note` are still used at `:128`. Point the header comment's `buildContext` reference (`:6`) at "the workspace strategy's `sessionContext` (jit: `buildContext`)".

- [ ] **Step 5: `hooks.ts` dispatches**

```ts
/**
 * sandbox hooks gate — PreToolUse gate (docs/jit-context-system.md §6).
 *
 * CLI-registered path (`sandbox hooks gate`; manual runs, tests), dispatched to
 * the workspace's strategy. The per-edit hook jit installs is special-cased by
 * the `./sandbox` wrapper to exec the gate module directly, bypassing this —
 * only jit installs that hook, so the fast path stays jit's.
 */

import { findWorkspaceRoot } from "sandbox-core/gate";
import { strategyFor } from "sandbox-core/strategies";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action !== "gate") {
    return;
  }
  let strategy;
  try {
    strategy = strategyFor(findWorkspaceRoot(process.cwd()) ?? process.cwd());
  } catch {
    return; // a hook must never block the tool call
  }
  strategy.gate();
}
```

- [ ] **Step 6: The MCP tools dispatch**

In `apps/mcp/tools.ts`, replace `import { checkSkills, syncSkills } from "sandbox-core/workspace_skills";` with `import { strategyFor } from "sandbox-core/strategies";`. If nothing else uses `writeWorkspaceHooks`, remove `import { writeWorkspaceHooks } from "sandbox-core/hooks_gen";`. Check with `grep -n writeWorkspaceHooks apps/mcp/tools.ts`.

`sandbox-skills`: set the title to `"Check or sync a workspace's context layer"`, and set the description to `` "`check` reports drift between the workspace's context layer and a fresh rendering; `sync` rewrites what drifted. The layer is the workspace's `context_strategy` (jit: sb-* skills and gate manifest; icm: standards and stage contracts)." ``. Then change the handler body to:

```ts
        const workspace = resolveWorkspaceDir(feature);
        const strategy = strategyFor(workspace);
        return args.action === "sync"
          ? { ...strategy.sync(workspace) }
          : { drift: strategy.check(workspace) };
```

`sandbox-hooks`: keep the name. Set the title to `"Refresh a workspace's context layer"`, and set the description to `` "Refresh the workspace's context layer the way `sandbox up` does: jit re-merges its SessionStart and PreToolUse hooks into .claude/settings.json; icm removes any sandbox-managed hooks. Never touches hooks it does not own." ``. Then change the handler body to:

```ts
        const workspace = resolveWorkspaceDir(feature);
        const strategy = strategyFor(workspace);
        strategy.refresh(workspace);
        return { strategy: strategy.id };
```

- [ ] **Step 7: Docs**

`docs/jit-context-system.md` §5 "Delivery artifacts": add as the section's first sentence: "These artifacts are written by the `jit` context strategy (`packages/sandbox-core/strategies/jit.ts`); `context_strategy` in `workspace.yml` selects it, and it is the default."

§11 "Portability": append: "`packages/sandbox-core/strategies/icm.ts` is a worked example of R2/R3 with no hooks at all: the `icm` strategy delivers the same standards through a staged-folder pipeline the agent walks by itself."

`docs/context-strategies.md`: replace its `Status:` line with `Status: option B implemented — spec docs/superpowers/specs/2026-09-27-context-strategy-interface.md. The rest of this page is the exploration that chose it.`

- [ ] **Step 8: Run everything and the naming check**

Run: `npm run build && npm test` at the repo root.
Expected: PASS.

Run: `grep -rn '"jit"\|"icm"' packages/sandbox-core/*.ts apps/cli/src/commands apps/mcp/tools.ts`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/commands/skills.ts apps/cli/src/commands/notes.ts apps/cli/src/commands/hooks.ts apps/cli/src/commands/__tests__/strategy_commands.test.ts apps/mcp/tools.ts packages/sandbox-core/strategy-notes-absent.test.mjs docs/jit-context-system.md docs/context-strategies.md
git commit -m "feat: skills, notes context, hooks gate and MCP tools dispatch to the strategy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# PR 4 — the remaining templates and switching

### Task 7: `bugfix`/`incident`, `refactor` and `spike` templates

**Files:**
- Modify: `packages/sandbox-core/strategies/icm_templates.ts`
- Test: `packages/sandbox-core/strategy-icm-templates.test.mjs`

**Interfaces:**
- Consumes: `Stage`, `ship`, `IMPLEMENT_STEPS`, `TEST_STEP`, `RELOAD_RULE` (Task 3, same file); `WORK_TYPE_PHASES` keys (`workspace_prompts.ts`), the same table that drives the JIT work types.
- Produces: `ICM_TEMPLATES` with keys `feature`, `bugfix`, `incident`, `refactor`, `spike`.

- [ ] **Step 1: Write the failing test**

```js
// Every work type the wizard offers (WORK_TYPE_PHASES) has an icm template,
// and each renders without holes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { strategyById } from "./dist/strategies/index.js";
import { ICM_TEMPLATES, templateFor } from "./dist/strategies/icm_templates.js";
import { WORK_TYPE_PHASES } from "./dist/workspace_prompts.js";

const EXPECTED = {
  feature: ["research", "spec", "implement", "ship"],
  bugfix: ["reproduce", "fix", "verify", "ship"],
  incident: ["reproduce", "fix", "verify", "ship"],
  refactor: ["scope", "implement", "ship"],
  spike: ["questions", "findings"],
};

test("every wizard work type has its template", () => {
  for (const wt of Object.keys(WORK_TYPE_PHASES)) {
    assert.ok(Object.hasOwn(ICM_TEMPLATES, wt), `no icm template for ${wt}`);
    assert.deepEqual(templateFor(wt).map((s) => s.name), EXPECTED[wt], wt);
  }
});

test("each template renders with no undefined and a route per stage", async () => {
  for (const wt of Object.keys(EXPECTED)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${wt}-`));
    try {
      await withSandboxHome(() =>
        withReporter(collectingReporter(), async () =>
          strategyById("icm").init({
            workspaceRoot: root,
            workspaceName: "demo",
            repos: [["repo", "me/demo"]],
            task: "t",
            meta: { FEATURE: "demo", SERVICES: "api" },
            inputs: { work_type: wt, starting_prompt: "p" },
            hasServiceMap: false,
            configOverride: null,
          }),
        ),
      );
      const dirs = fs.readdirSync(path.join(root, "stages")).sort();
      assert.deepEqual(dirs, EXPECTED[wt].map((n, i) => `0${i + 1}_${n}`), wt);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      for (const d of dirs) {
        assert.match(claude, new RegExp(`stages/${d}/CONTEXT\\.md`), `${wt}: no route to ${d}`);
        const c = fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8");
        assert.doesNotMatch(c, /undefined/, `${wt}/${d}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-templates.test.mjs`
Expected: FAIL with `no icm template for bugfix`.

- [ ] **Step 3: Add the templates**

In `icm_templates.ts`, insert this after `const feature: Stage[] = [...]`, and change `ICM_TEMPLATES` to `{ feature, bugfix, incident: bugfix, refactor, spike }`:

```ts
const bugfix: Stage[] = [
  {
    name: "reproduce",
    job: "reproduce and locate the root cause",
    writes: "`output/repro.md`",
    check: "agree the root cause",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: make the failure happen on demand and name its root cause. No fix is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} on the failing path — follow the call chain, don't read whole trees`,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports, logs, test command",
      ],
      doNotLoad: "`_shared/standards.md` (nothing is written here), other stages' contracts, `.sandbox/*.yml`.",
      process: [
        "Reproduce the failure against the running service or with a test. Record the exact command and its output.",
        "Write the smallest failing test that captures it, in the style of the nearest existing test. Do not commit it yet.",
        "Trace to the root cause: the first place the code does something other than intended. A symptom site is not a root cause.",
        "List every other caller of the function at the root cause — a fix there reaches them too.",
        "Write `output/repro.md`: steps 1–4, and a proposed fix in one paragraph under a `status: proposed` line.",
      ],
      outputs: ["`output/repro.md`", "One failing test, uncommitted"],
      humanCheck:
        "Read `output/repro.md`. Correct the root cause or the proposed fix if needed, then change `status: proposed` to `status: decided`. That is the approval — the next session starts the fix without asking again.",
    }),
  },
  {
    name: "fix",
    job: "fix it at the root cause",
    writes: "code diff, `output/fix.md`",
    check: "read the diff; the failing test now passes",
    enter:
      "`stages/01_reproduce/output/repro.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "all",
    contract: (v) => ({
      oneJob: "One job: make the failing test pass by changing the code at the root cause, and nothing else.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — must read \`status: decided\`; if not, stop and route back`,
        "Working (this run): the failing test and the files at the root cause",
        "Reference (every run): `../../.sandbox/sandbox-context.md` — test command",
      ],
      doNotLoad: "`BRIEF.md` (`repro.md` carries the settled scope), `.sandbox/*.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "Apply the fix `repro.md` settled, at the root cause. Every caller `repro.md` lists gets the fix through the shared function — do not patch callers one by one.",
        TEST_STEP,
        "Write `output/fix.md`: `git diff --stat` per repo, the failing test's name, and the test exit code and summary line.",
      ],
      outputs: ["Code changes plus the test, uncommitted", "`output/fix.md`"],
      humanCheck: "Read the diff. Confirm the fix sits where `repro.md` put the root cause. Edit in place if not.",
    }),
  },
  {
    name: "verify",
    job: "prove it against the running service",
    writes: "`output/verify.md`",
    check: "the original reproduction no longer fails",
    standards: "none",
    contract: (v) => ({
      oneJob: "One job: show the original failure is gone in the running service, not just in the test.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — the reproduction steps`,
        `Working (this run): \`${v.at("fix")}/output/fix.md\``,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports",
      ],
      doNotLoad: "`_shared/standards.md` (no code is written here), source files, `.sandbox/*.yml`.",
      process: [
        `Reload the running code: ${v.restart}. ${RELOAD_RULE}`,
        "Rerun the reproduction steps from `repro.md` exactly. Capture the output.",
        "Exercise one neighbouring path through each caller `repro.md` listed. Capture the output.",
        "Write `output/verify.md`: steps 2–3 with their output, and PASS or FAIL for each.",
      ],
      outputs: ["`output/verify.md`"],
      humanCheck: "Read `verify.md`. A FAIL sends the run back to the fix stage.",
    }),
  },
  ship,
];

const refactor: Stage[] = [
  {
    name: "scope",
    job: "fix the boundary and the invariants",
    writes: "`output/scope.md`",
    check: "agree what must not change",
    standards: "none",
    contract: (v) => ({
      oneJob: "One job: pin down what the refactor may touch and what behaviour must not change. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names, and their callers`,
      ],
      doNotLoad: "`_shared/standards.md` (nothing is written here), other stages' contracts, `.sandbox/*.yml`.",
      process: [
        "List the files in scope and every caller outside it.",
        "State the invariants: observable behaviour that must be identical after the refactor.",
        "Name the existing tests that pin each invariant, and the gaps no test covers.",
        "Write `output/scope.md`: steps 1–3, the sequence of small steps you propose, and a `status: proposed` line.",
      ],
      outputs: ["`output/scope.md`"],
      humanCheck:
        "Read `output/scope.md`. Correct the scope or invariants, then change `status: proposed` to `status: decided`. That is the approval — the next session starts without asking again.",
    }),
  },
  {
    name: "implement",
    job: "refactor in green steps",
    writes: "code diff, `output/verify.md`",
    check: "read the diff; tests green at every step",
    enter:
      "`stages/01_scope/output/scope.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "all",
    contract: (v) => ({
      oneJob: "One job: carry out the steps `scope.md` settled, keeping every invariant true after each one.",
      inputs: [
        `Working (this run): \`${v.at("scope")}/output/scope.md\` — must read \`status: decided\``,
        "Working (this run): the files in scope",
        "Reference (every run): `../../.sandbox/sandbox-context.md` — test command",
      ],
      doNotLoad: "`BRIEF.md` (`scope.md` carries the settled scope), `.sandbox/*.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "First add a test for each invariant gap `scope.md` named. They must pass before any code moves.",
        `Take the steps in order. After each one: ${TEST_STEP}`,
        `Reload and exercise the service once at the end: ${v.restart}. ${RELOAD_RULE}`,
        "Write `output/verify.md`: `git diff --stat` per repo, the test result after each step, and the final exercise output.",
      ],
      outputs: ["Code changes, uncommitted", "`output/verify.md`"],
      humanCheck: "Read the diff against `scope.md`. Anything outside scope goes back.",
    }),
  },
  ship,
];

const spike: Stage[] = [
  {
    name: "questions",
    job: "frame what the spike must answer",
    writes: "`output/questions.md`",
    check: "agree the questions and what settles them",
    standards: "none",
    contract: () => ({
      oneJob: "One job: turn the brief into questions, each with the evidence that would settle it. No code is written in this stage.",
      inputs: ["Working (this run): `../../BRIEF.md`"],
      doNotLoad: "source trees, `_shared/standards.md`, `.sandbox/*.yml`.",
      process: [
        "List the questions the brief asks or implies, most decision-relevant first.",
        "For each: how it will be answered (read code, measure, prototype) and what result settles it.",
        "Write `output/questions.md`: steps 1–2 and a `status: proposed` line.",
      ],
      outputs: ["`output/questions.md`"],
      humanCheck:
        "Edit the questions, then change `status: proposed` to `status: decided`. That is the approval — the next session starts without asking again.",
    }),
  },
  {
    name: "findings",
    job: "answer them with evidence",
    writes: "`output/findings.md`",
    check: "decide the next piece of work",
    enter:
      "`stages/01_questions/output/questions.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "none",
    contract: (v) => ({
      oneJob: "One job: answer each settled question with evidence, and recommend what to build next.",
      inputs: [
        `Working (this run): \`${v.at("questions")}/output/questions.md\` — must read \`status: decided\``,
        `Working (this run): whatever each question's method names, in ${v.repos}`,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — ports, containers",
      ],
      doNotLoad: "`_shared/standards.md` (prototype code is throwaway), `.sandbox/*.yml`.",
      process: [
        "Answer each question by its method. Prototype code lives in `output/` or on a scratch branch, never on the workspace branch.",
        "Write `output/findings.md`: per question, the answer, the evidence (commands and output), and confidence.",
        "End `findings.md` with a recommendation: the next work item and its work type.",
      ],
      outputs: ["`output/findings.md`"],
      humanCheck: "Read `findings.md`. The recommendation becomes the brief of the next workspace, or the spike ends here.",
    }),
  },
];
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-icm-templates.test.mjs strategy-icm-init.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/strategies/icm_templates.ts packages/sandbox-core/strategy-icm-templates.test.mjs
git commit -m "feat(core): icm templates for bugfix, incident, refactor and spike

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Switching strategy — the leftover warning and `--prune-context`

**Files:**
- Modify: `packages/sandbox-core/strategies/index.ts` (`leftoverPaths`, `reportLeftovers`)
- Modify: `packages/sandbox-core/workspace_init.ts` (call after `strategy.init`)
- Modify: `apps/cli/src/main.ts` (`--prune-context` on `init-workspace` only)
- Test: `packages/sandbox-core/strategy-switch.test.mjs`

**Interfaces:**
- Consumes: `previous` and `strategy` locals from Task 5; `run` from `proc.ts` (`run(argv, { capture: true }) → { status, stdout, stderr }`); `strategyById`.
- Produces: `leftoverPaths(root: string, from: ContextStrategy, to: ContextStrategy): string[]` and `reportLeftovers(root: string, from: ContextStrategy, to: ContextStrategy, prune: boolean): void`.

- [ ] **Step 1: Write the failing test**

```js
// Switching context_strategy leaves the old layer in place with a warning;
// --prune-context deletes only what git can restore, and never a path the new
// strategy also owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { leftoverPaths, reportLeftovers, strategyById } from "./dist/strategies/index.js";

const jit = strategyById("jit");
const icm = strategyById("icm");

function write(root, rel, body = "x\n") {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function jitWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-"));
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write(root, "CLAUDE.md");
  write(root, ".claude/skills/sb-research/SKILL.md");
  write(root, ".claude/skills/mine/SKILL.md");
  write(root, ".claude/agents/sb-researcher.md");
  write(root, ".claude/settings.json", "{}\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  write(root, ".claude/agents/sb-researcher.md", "edited\n"); // dirty
  write(root, ".sandbox/notes/001-handoff-x.md"); // untracked
  return root;
}

test("leftovers are the old layer's existing paths minus the new layer's", () => {
  const root = jitWorkspace();
  try {
    assert.deepEqual(leftoverPaths(root, jit, icm), [
      ".claude/settings.json",
      ".claude/skills/sb-research",
      ".claude/agents/sb-researcher.md",
      ".sandbox/notes",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without prune: one warning, nothing deleted", async () => {
  const root = jitWorkspace();
  try {
    const c = collectingReporter();
    await withReporter(c, async () => reportLeftovers(root, jit, icm, false));
    assert.match(c.text(), /jit layer still present: .*\.claude\/skills\/sb-research.*--prune-context/);
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "sb-research")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prune deletes tracked clean paths only", async () => {
  const root = jitWorkspace();
  try {
    const c = collectingReporter();
    await withReporter(c, async () => reportLeftovers(root, jit, icm, true));
    assert.ok(!fs.existsSync(path.join(root, ".claude", "skills", "sb-research")));
    assert.ok(!fs.existsSync(path.join(root, ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "mine", "SKILL.md")), "not jit's");
    assert.equal(fs.readFileSync(path.join(root, ".claude", "agents", "sb-researcher.md"), "utf8"), "edited\n");
    assert.ok(fs.existsSync(path.join(root, ".sandbox", "notes", "001-handoff-x.md")), "untracked kept");
    assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")), "icm owns it too");
    assert.match(c.text(), /Kept \.claude\/agents\/sb-researcher\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("not a git repo: prune keeps everything", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-nogit-"));
  try {
    write(root, ".claude/skills/sb-research/SKILL.md");
    await withReporter(collectingReporter(), async () => reportLeftovers(root, jit, icm, true));
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "sb-research", "SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-switch.test.mjs`
Expected: FAIL with `leftoverPaths is not a function`.

- [ ] **Step 3: Implement in `strategies/index.ts`**

Add `import { run as procRun } from "../proc.js";` and `import { success, warn } from "../reporter.js";`, then:

```ts
/** Expand `ownedPaths` against the workspace; a trailing `*` is a name-prefix glob. */
function expandOwned(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("*")) {
      if (fs.existsSync(path.join(root, pattern))) out.push(pattern);
      continue;
    }
    const dir = path.dirname(pattern);
    const prefix = path.basename(pattern).slice(0, -1);
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) if (name.startsWith(prefix)) out.push(path.join(dir, name));
  }
  return out;
}

/** What *from* left behind that *to* does not also own. */
export function leftoverPaths(root: string, from: ContextStrategy, to: ContextStrategy): string[] {
  const keep = new Set(expandOwned(root, to.ownedPaths()));
  return expandOwned(root, from.ownedPaths()).filter((p) => !keep.has(p));
}

// Tracked and clean is the only state git can put back, so it is the only
// state --prune-context deletes. Untracked, ignored, modified and non-git
// paths are kept.
function restorable(root: string, rel: string): boolean {
  const tracked = procRun(["git", "-C", root, "ls-files", "--error-unmatch", "--", rel], { capture: true });
  if (tracked.status !== 0) return false;
  const status = procRun(
    ["git", "-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", rel],
    { capture: true },
  );
  return status.status === 0 && !status.stdout.trim();
}

/** docs/context-strategies.md §3.6: warn about the old layer, or prune it. */
export function reportLeftovers(root: string, from: ContextStrategy, to: ContextStrategy, prune: boolean): void {
  const left = leftoverPaths(root, from, to);
  if (!left.length) return;
  if (!prune) {
    warn(
      `${from.id} layer still present: ${left.join(", ")}; remove by hand or run ` +
        "`sandbox init-workspace --prune-context`",
    );
    return;
  }
  for (const rel of left) {
    if (restorable(root, rel)) {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      success(`Pruned ${rel}`);
    } else {
      warn(`Kept ${rel}: untracked, ignored or modified — git could not restore it`);
    }
  }
}
```

- [ ] **Step 4: Call it from `initWorkspace` and add the flag**

In `workspace_init.ts`, directly after the `strategy.init({...});` call:

```ts
  if (previous !== null && previous !== strategy.id) {
    reportLeftovers(workspaceRoot, strategyById(previous), strategy, Boolean(args["prune_context"]));
  }
```

Add `reportLeftovers` to the `./strategies/index.js` import.

`apps/cli/src/main.ts`, in the `init-workspace` spec only: add

```ts
        .option(
          "--prune-context",
          "After a context_strategy change, delete the previous strategy's files that git " +
            "tracks unmodified (anything else is kept and reported).",
        )
```

and add `prune_context: Boolean(o.pruneContext),` to its `namespace`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npx tsc && node --test strategy-switch.test.mjs && npm test`
Expected: PASS. Then `cd ../../apps/cli && npx vitest run && npx tsc --noEmit`: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/strategies/index.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/strategy-switch.test.mjs apps/cli/src/main.ts
git commit -m "feat: warn about the previous context layer on a strategy switch; --prune-context removes it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Use `git add -p apps/cli/src/main.ts` if the user's WIP is still uncommitted.

### Task 9: End-to-end check against icm-ws2

**Files:** none changed. This task is verification only.

- [ ] **Step 1: Build and create an ICM workspace from icm-ws2's inputs**

Run: `npm run build`, then `sandbox workspace icm-check --context-strategy icm --work-type feature --repos demo-services --services backend --starting-prompt "$(yq -r .starting_prompt ~/features/icm-ws2/.sandbox/workspace.yml)"`. If `yq` is absent, paste the prompt by hand.

Expected: the workspace has `CLAUDE.md`, `CONTEXT.md`, `BRIEF.md`, `_shared/standards.md`, and `stages/0{1..4}_*/{CONTEXT.md,output/.gitkeep}`. It has **no** `.claude/`, `.sandbox/notes/` or `.sandbox/standards.json`.

- [ ] **Step 2: Compare with the hand-built run**

Run: `diff -r ~/features/icm-ws2/stages <new-workspace>/stages --exclude=output; diff ~/features/icm-ws2/_shared/standards.md <new-workspace>/_shared/standards.md`

Expected: differences are only the deliberate generalisations (repo and output file names, the generic research → spec → implement → ship wording). No run-2 lesson may be missing: a `decided` status is the approval, `docker restart icm-check-backend` is used, and the test command is quoted from `sandbox-context.md`. Report the diff to the user; do not "fix" it toward icm-ws2 without asking.

- [ ] **Step 3: `sandbox up` leaves `.claude/` absent**

Run: `cd <new-workspace> && sandbox up && ls -a`
Expected: no `.claude/`. Then run `sandbox skills check`, expecting `Context layer fresh (icm).` and exit 0. Tear down with `sandbox remove-workspace icm-check` once the user has seen it.

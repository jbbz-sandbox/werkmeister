# Gap #3 (Context compression) — diff-scoped active-standards re-injection

> **Status:** design approved 2026-07-18. Scopes the *standards-survival* half of the
> Compress bucket. Sibling: gap #2 (source reduction, shipped `5ad0cde1b`). Branch:
> `multi-feature`. Ponytail: ACTIVE.
> **Handoff:** [context-engineering-gaps-HANDOFF.md](../../context-engineering-gaps-HANDOFF.md) gap #3.

## Problem

After a compaction squash, the full text of any `tr-<domain>-standard` skill the agent had
loaded is gone. That is JIT working as designed — the standard was loaded just-in-time and
should not persist forever. But it opens a compliance hole:

- CLAUDE.md's Standards-routing table **does** survive compaction (Claude Code re-injects
  CLAUDE.md into every context window). So the agent still knows *which* standards exist and
  their globs.
- The routing table's trigger, however, is *"invoke `sb-service-standard` **before** editing
  service files."* A mid-task agent is **already** editing those files — it never hits a
  fresh "before" moment, so it never re-triggers the skill, and silently stops complying with
  rules whose text was squashed.

This is the **degradation-gap failure** (a loaded-but-unattended standard being ignored —
measured 0/3 on Haiku, harness-5) recurring across the **compaction boundary**, where the
degradation fix (precedence block + step-6 recitation) cannot help because that reasoning was
itself squashed.

**Not measured:** we have not run a probe confirming the drop recurs specifically across
compaction (only within a window). Building the fix is free; any behavioral eval is deferred
to gap #1's approved-spend track (see Non-goals).

## Fix — extend the existing re-injection, no new hook

The `SessionStart` hook (`apps/cli/src/lib/hooks_gen.ts`) already fires `sandbox notes context` on
every context window, compaction included (matcher-less, `compact` source covered). We append
a diff-scoped standards block to that existing output. No new hook, no new command.

### Component 1 — the matcher (`apps/cli/src/lib/notes.ts`)

New pure-ish function `active_standards_from_diff(workspace: Path) -> list[tuple[str, str]]`
returning `[(skill_name, summary), …]`:

1. **Enumerate repos** = immediate subdirectories of `workspace` that contain a `.git` entry
   (dir or file — worktrees use a file). Same pattern already used by
   `config._detect_workspace_from_cwd`.
2. **Collect changed paths** per repo:
   - Branch scope: `git -C <repo> diff --name-only <merge-base>...HEAD`, where
     `<merge-base> = git -C <repo> merge-base HEAD <base>` and `<base>` is the first of
     `origin/main`, `main` that resolves. If neither the base ref nor the merge-base can be
     resolved, **degrade to uncommitted-only** (do not fail).
   - Uncommitted: `git -C <repo> status --porcelain` → the path column (handles staged,
     unstaged, and untracked).
   - Every `git` call runs under `subprocess.run(..., timeout=…)` — the README's hung-
     `kubectl` lesson: an unbounded git call in a session-launch hook can hang the launch.
3. **Match** via `standards.load_standards_modules()`: `fnmatch` each changed path against
   each module's `applies_to` globs. Any match → that domain is active.
   - `# ponytail: fnmatch translates both '*' and '**' to '.*', so it matches across '/'
     boundaries — permissive in the direction we want. Worst case = one extra one-liner
     re-injected. Swap to pathspec only if false positives get noisy.`
   - Universal base: if **any** changed file exists at all, include `comments` (its rule is
     "any code edit", not a glob).
4. **Return** `[(skill_gen.skill_name_for(domain), module["summary"]), …]`, sorted with
   `comments` last (least specific), summaries stripped/capped.

**Deliberately NOT using `resolve_active_standards()`:** that resolves standards from the
workspace's *selected services / archetypes* — the truest signal for re-anchoring is "a file
I changed matches this standard's globs", which also catches cross-cutting edits the archetype
set would miss. Matching all loadable modules against the diff is both simpler and more correct
here.

### Component 2 — the render (`apps/cli/src/commands/notes.ts`)

In `build_context`, after the handoff/decision sections, if `active_standards_from_diff`
returns anything, append:

```
── Active standards (files changed on this branch match these) ──
You loaded these standards earlier this session; compaction dropped the full rules.
Re-invoke the skill to reload them before editing matching files again — CLAUDE.md's
routing table only re-triggers *before* a new edit, not mid-task.
- sb-service-standard — Service-boundary contract — REST/Nest, GraphQL federation/Relay, …
- sb-comments-standard — comments explain the why, never the what.
```

The directive line carries the entire value-add over the routing table CLAUDE.md already
provides: an explicit **re-invoke-now** instruction that the "invoke before editing" router
cannot give a mid-edit agent.

### Self-scoping

Because the block is diff-gated, it emits **nothing** on a fresh `SessionStart(startup)` with
no work done, and only appears once real changed work exists to re-anchor. The matcher-less
hook therefore needs no source-discrimination — the diff gate does it.

### Hook safety

`run()` in `commands/notes.ts` already swallows all exceptions and exits 0 (a context hook
must never break a launch). The matcher must uphold this: git failures, missing repos, and
timeouts return an empty list, never raise. `build_context` treats an empty list as "no block".

## Non-goals

- **Structured mid-task scratchpad + recitation** (the handoff's other gap-#3 clause):
  skipped. Recitation already shipped (sb-implement step-6, degradation fix); `.sandbox/notes/`
  already *is* the compaction-surviving structured scratchpad. A second scratchpad mechanism
  overlaps gap #4 (memory) and violates YAGNI. **Add when:** a workspace shows working-state
  loss that notes + this re-injection demonstrably do not cover.
- **Behavioral evaluation** (does re-injection restore post-compaction compliance?): deferred
  to gap #1's approved-spend track. Not part of this change. Any eval needs an explicit
  "yes, spend tokens" from Jay (backlog deferred 2026-07-05).
- **PreCompact-side shaping:** ruled out earlier (doc-verified) — PreCompact stdout never
  reaches the model. This fix works entirely on the SessionStart re-injection side.

## Test (ponytail's one runnable check)

`apps/cli/src/lib/__tests__/notes_standards.test.ts`:
- temp workspace containing a temp `git init` repo with a committed baseline on `main` and a
  changed `src/foo.service.ts`; a fake `docs/standards/` with `service` + `comments` modules →
  assert matcher returns `sb-service-standard` and `sb-comments-standard`.
- clean repo (no diff) → assert matcher returns `[]`.
- assert `build_context` includes the re-inject directive when the matcher is non-empty and
  omits the block when empty.

## Files touched

- `apps/cli/src/lib/notes.ts` — new `active_standards_from_diff` (+ small git/glob helpers).
- `apps/cli/src/commands/notes.ts` — `build_context` renders the block.
- `apps/cli/src/lib/__tests__/notes_standards.test.ts` — new.

Reuses unchanged: `standards.load_standards_modules`, `skill_gen.skill_name_for`,
`hooks_gen` (the hook already fires), the existing `run()` exception envelope.

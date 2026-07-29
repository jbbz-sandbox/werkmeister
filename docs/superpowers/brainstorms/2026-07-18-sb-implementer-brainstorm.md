# `sb-implementer` — concurrent-implementation subagent (brainstorm)

> **Status:** BRAINSTORM / pre-spec. **Gated — do not advance to a spec until both gates
> below clear.** Next step (only after gates): run through the superpowers spec gate →
> `docs/superpowers/specs/YYYY-MM-DD-sb-implementer-design.md`.
> **Author:** design session 2026-07-18.
> **Context:** integrating a design→plan→implement framework (e.g. Superpowers) that
> *implements with subagents* on top of the JIT context system. Companion reading:
> [jit-agents-and-tools-spec.md](../../jit-agents-and-tools-spec.md) §3/§4.4 (phase gates
> tools; implement stays main-agent by decision), [jit-standards-loading-spec.md](../../jit-standards-loading-spec.md)
> §5.9 (prevention-timing), [jit-README.md](../../jit-README.md) "Phases are tool-gates".

## Problem

Today implement runs in the **main agent** — a measured decision: isolation is a *cost*
there because "the user watches and corrects live" (agents spec §4.4). A framework that
implements *concurrently with subagents* wants the opposite. The question this doc scopes:
**can a generated `sb-implementer` subagent write source while preserving the two things
the main-agent loop provides — the standards guarantee (ponytail + `tr-*-standard` in
context before the first edit, §5.9) and human-in-the-loop correction — and if so, how?**

`sb-implementer` does not exist. `agent_gen.ts` emits only `sb-researcher` and
`sb-tester-<archetype>`. This is greenfield.

## Gates (must clear before this becomes a spec)

1. **A real need.** Concrete parallelizable implementation work (N independent,
   well-specified tasks with disjoint file sets). Absent that, this is YAGNI — HITL
   feature work is not parallel-shaped. Do not build speculatively.
2. **Harness 5 passes** (queued in
   [RESULTS.md](../../experiments/context-management/results/RESULTS.md) "What to run
   next"). If no delivery channel gets prevention rules into a subagent before its first
   edit ≥ the main-agent 15/15 baseline, `sb-implementer` is **not viable** — stop and
   keep implement in the main agent. Harness 5 also *decides* Question 2 below.

## Non-goals

- No `sb-design` / `sb-plan` phases and no `/design` `/plan` aliases (jit-README "Phases
  are tool-gates" — they share the read-only gate and duplicate the framework).
- Not replacing the main-agent implement path. `sb-implementer` is an *additional* option
  for parallelizable work, selected explicitly — the default stays main-agent HITL.

## Design questions (each: options → lean; none settled — that's the spec gate's job)

### Q1 — HITL substitution: how are mid-implement ambiguities handled, and what replaces the live human? *(the crux — everything else is mechanics)*

A subagent cannot `AskUserQuestion` or be corrected mid-stream.
- **(A) Hard return contract, no guessing** — on hitting an ambiguity the implementer
  stops, records it, and returns open questions; it never picks a side silently.
- **(B) TDD-gated autonomy** — the implementer works against a failing-test spec supplied
  by the plan; the test suite is the acceptance boundary a human review would otherwise be.
- **(C) Note checkpoints** — writes `decision`/`attempt` notes as it goes; the dispatcher
  reviews between sub-tasks.

**Lean: A + B together.** The plan hands each implementer a failing test as its contract
(B); anything the test doesn't pin down and the plan didn't specify is an open question
returned, not guessed (A). The main agent (dispatcher) surfaces those via AskUserQuestion
**before** accepting the diff — the HITL boundary moves from *during* implement to *at the
task edges*, which is the only place a subagent can honor it.

### Q2 — Standards delivery channel *(decided by Harness 5, not here)*

- **(A) `skills:` preload** — inject `sb-comments-standard` + matching `tr-*-standard`
  (and `ponytail` if plugin-preload works) as full content at subagent startup.
- **(B) `tools: [Skill]` + invoke-first contract** — first instruction is "invoke
  ponytail + the matching standard before editing."

**Lean: A for project standards; A-or-B for `ponytail`** depending on whether Harness 5
arm 2 shows plugin skills can be preloaded. Preload is structurally equivalent to
`sb-implement`'s phase-entry load; invoke-first reintroduces the description-match
unreliability harness 2 measured, so it's the fallback, not the default.

### Q3 — Notes are files, not skills

Preloaded skills don't cover `.sandbox/notes/`. The implementer must still honor
`decision`/`contract` notes (binding, with the override-precedence rule) like
`sb-implement` step 3 does.
**Lean:** bake "read `.sandbox/notes/` decision+contract notes before editing; a decision
note conflict is an open question, not a silent choice" into the def as step 1. Files →
`Read` suffices; no new mechanism.

### Q4 — Note `NNN` collisions under real concurrency

Notes-spec open question #3 ("two subagents numbering notes collide on NNN") was parked as
"likely fine — writers are sequential in HITL." Parallel implementers break that.
- **(A)** filename carries the agent slug (`NNN-decision-<agent>-<slug>.md`) — no shared
  counter to race.
- **(B)** dispatcher reserves an `NNN` block per implementer.
- **(C)** a claim/lock file.

**Lean: A** (agent-slug in filename) — no coordination, no lock, and the notes readers
glob the directory anyway. Revisit only if ordering-by-NNN matters more than collision-free.

### Q5 — File-conflict isolation

Parallel implementers editing the same repo → git conflicts.
- **(A) worktree isolation per agent** (the Agent tool's `isolation: 'worktree'`).
- **(B) partition tasks to disjoint file sets** (the plan guarantees no overlap).
- **(C) serialize edits** (defeats the purpose).

**Lean: B as the common case, A as the guarantee.** Partition by service/archetype where
the plan can prove disjoint files (cheap); fall back to worktree isolation when it can't
(the spec says it's ~200–500ms + disk per agent — pay it only when needed).

### Q6 — Contracted mid-implement capture

The "write the decision/attempt note when it settles" rule is main-agent-only today and
itself **unmeasured** (notes-spec open question §4.3.3; uncontracted subagent writes were
0/3). A subagent must have it *contracted*, not in-body-advisory.
**Lean:** put it in the return contract; add a Harness-5 follow-on measuring whether a
contracted implementer actually captures mid-run (vs. only at return).

### Q7 — Spawn granularity: per-archetype or per-task?

`sb-tester` is one agent per archetype *present*. Implement is different — a plan may have
many independent tasks within one archetype.
- **(A) per-archetype** (mirror tester) — simple, but serializes tasks within an archetype.
- **(B) per-task ephemeral** — dispatcher spawns one implementer per plan task, each
  carrying its archetype's preloaded standards + its one task's failing test.

**Lean: B.** Parallelism lives at the *task* level; the archetype only decides *which
standards preload*. This diverges from the tester model deliberately and is the main
generator-design consequence (see Q8).

### Q8 — Generator + dispatch mechanics *(smallest part)*

- `agent_gen.ts`: `build_implementer_agent(spec)` + per-archetype spec assembly (mirrors
  the tester functions); `write_workspace_agents` emits/prunes. `archetypes.ts::resolve_present_archetypes`
  already gives presence for free. If Q7=B, the generated file is a *template* the
  dispatcher parameterizes per task (or the dispatcher composes the def inline).
- **Dispatch:** either a `sb-implement` variant that fans out, or the framework's
  orchestrator. HITL: the main agent dispatches, collects diffs + open questions, and
  gates on AskUserQuestion before merge.
- Tests: `agent_gen.test.ts`.

## Open measurement dependencies

- **Harness 5** (Q2) — the viability gate.
- **Harness 5 follow-on** (Q6) — contracted mid-run capture compliance.
- Both must land in RESULTS.md before the spec claims either as fact — no un-measured
  load-bearing claims (the system's standing rule).

## What a "done" spec looks like

Q1–Q7 each resolved to a single decision with rationale (superpowers "Key settled
decisions" style), anchored to Harness 5 results where applicable; a build plan sequencing
Q8; and an explicit statement that the main-agent path remains the default.

# Context-Engineering Gaps — Review Handoff

> **Status:** OPEN — degradation gap closed AND measured (2026-07-18, `3d736faea`); **gap #2
> (context optimization) shipped 2026-07-18 (`5ad0cde1b`)**; **gap #1 (evaluation) baseline
> measured 2026-07-18 (harness-6: loaded 9/9, control 0/9 on Haiku)**; **gap #3 (compression,
> standards-survival half) shipped 2026-07-18 (`b725f8956`, pushed)**. Next session picks up
> gap #4 (memory) or a follow-on. This tracks the *remaining* context-engineering gaps.
> **Branch:** `multi-feature` (permanent, never merges to `main`).
> **Prior art:** the base JIT system is SHIPPED (`docs/jit-README.md` = current state).
> Decisions in the three base specs are settled; do not re-litigate.

## The frame

A survey this session mapped the JIT system against the installed **`context-engineering`**
skill suite (plugin: `context-engineering-marketplace`). Finding:

**The JIT system is a thorough build of the *inflow/routing* half of context engineering —
it Selects (glob-gated standards) and Isolates (subagents + return contracts) well. The
*outflow/degradation* half and the *evaluation* half are the gaps.** The research doc admits
this at [context-management-research.md](context-management-research.md) L419:
*"Nothing manages what flows out."*

Mapping onto the degradation skill's four-bucket framework (Write / Select / Compress /
Isolate): the system is strong in **Select** and **Isolate**, partial in **Write**
(`.sandbox/notes/`), and absent in **Compress**.

## Already closed — the degradation gap (fix 2026-07-18 `baa66c9d9`; measured 2026-07-18 `3d736faea`)

The "read-but-not-applied" failure (a correctly-loaded standard the code ignores) was
diagnosed as **context clash** + **lost-in-middle** and fixed with skill wording:
`sb-implement` got a tiered surface-and-proceed **precedence block** (invariant wins / rule
surfaces / nit silent) + a **step-6 recitation** rule; `sb-review` got the mirror.

**Now measured** (harness-5, subagent stand-in — full record in
[experiments/context-management/results/harness5.md](experiments/context-management/results/harness5.md)):
- The runbook's config bait was **invalid** (correctness backstop — Opus writes the right
  value with the standard removed), so re-run on a **backstop-free conventional rule** ×
  **Haiku** (subagent-tier model). There, read-but-not-applied is real: baseline **0/3**.
- The **precedence block is the load-bearing half** (precedence-only 3/3, recitation-only
  0/3, full fix 2/3; survives 135K burial 3/3). **Recitation kept** as cheap insurance for
  the high-burial regime the harness couldn't reach (decision, not a cut).
- Cost ~$5–6 / 36 subagent runs; edit-early cells (the decisive ones) were <$1.

**This gap is closed — do not re-run it.** The durable lesson feeds gap #1 below: a
loaded-AND-applied eval must use a pure-convention bait on the weakest deployed model, or it
measures nothing.

## Remaining gaps to review — in recommended order

| # | Gap | Skill | Bucket | What to evaluate against the JIT system |
|---|-----|-------|--------|------------------------------------------|
| 1 | **Evaluation** — BASELINE DONE 2026-07-18 (`harness6.md`) | `context-engineering:evaluation` | — | harness-6 generalized the "loaded **AND applied**" check across 3 backstop-free baits (service/observability/data) on Haiku: **loaded 9/9 applied, control 0/9** — the precedence fix generalizes beyond harness-5's one rule, ~$1. Spec: `docs/superpowers/specs/2026-07-18-loaded-and-applied-eval-baseline-design.md`. **Still open:** turning this one-shot into a *standing* re-runnable check (deferred: don't automate what you run once) and the real-diff correlational spot-check (needs a per-standard oracle). |
| 2 | ~~**Context optimization**~~ SHIPPED 2026-07-18 (`5ad0cde1b`) | `context-engineering:context-optimization` | Compress | Mid-session command-output balloon (test/build/typecheck dumps) buried phase-entry standards. Fix = a command-output-offload rule in `sb-implement` (redirect verbose checks to a file, read only the failing slice). Test/research phases already isolate via subagents. Narrow-file-read + harness masking cut as redundant/out-of-reach. Spec: `docs/superpowers/specs/2026-07-18-context-optimization-command-offload-design.md`. Behavioral eval deferred to gap #1. |
| 3 | ~~**Context compression**~~ SHIPPED `b725f8956`; **behavioral eval RAN 2026-07-18 (`harness7.md`) — found a gap** | `context-engineering:context-compression` | Compress | Standards-survival half done: `sandbox notes context` re-injects diff-matched active standards' one-liners + a re-invoke directive on session start (`standards.standards_matching_diff` → `commands/notes.build_context`). Spec: `docs/superpowers/specs/2026-07-18-context-compression-standards-reinjection-design.md`. **harness-7 (15 Haiku cells, ~$0.50–0.70) overturned the design's premise:** the re-inject **summary re-anchors awareness but NOT compliance** — the *enriched* summary (naming `page`/`perPage` verbatim) still scored **0/3** on pagination, cells *citing* the standard then overriding it for the task. Missing ingredient = the **precedence block** (invariant-wins / surface-and-proceed), squashed at compaction and never re-delivered (harness-6 loaded = 3/3 *with* precedence → 0/3 without). **Revised lever (unbuilt, Jay's call):** append a compressed precedence directive to the re-inject block — the post-compaction analog of the degradation fix. See [results/harness7.md](experiments/context-management/results/harness7.md). |
| 4 | **Memory maturity** | `context-engineering:memory-systems` | Write | `.sandbox/notes/` is a chronological append-and-supersede log; retrieval is by recency, not relevance. Upgrade path (only if the pain is real): entity/topic-index notes so a session pulls notes *about the file/service it's touching* — i.e. apply the glob-gating you already use for standards to notes. |

**Why this order:** eval first because it converts the rest from opinion to measurement
(and Jay deferred it for *token cost*, not disagreement — so the cheap eval, not the
harness). Then optimization/compression (the Compress bucket, entirely absent, biggest
attention risk in long coding sessions). Memory last — it's a maturity upgrade, not a live
bug; don't build it until a workspace's note pile visibly hurts.

## Future thread (not a gap) — standards that make the codebase context-engineerable

Raised by Jay 2026-07-18. Every gap above is **consume-side** (how an agent ingests an
existing codebase). The inverse lever: **author the code artifact so it's easier to
context-engineer against.** Code standards then reinforce the other three buckets:

- **Structured JSON logging with identifiable fields** → an agent greps one field for the
  failing slice instead of inhaling the whole log — directly reinforces **Compress** (gap
  #2's offload-and-narrow lever).
- **File / path naming conventions** → deterministic glob-triggering of the right standard —
  reinforces **Select** (the standards router the system already runs on globs).
- Candidates in the same spirit (not yet mined): stable typed **error codes / named errors**
  (jump to the failing slice, don't re-read the dump — Compress); **behavior-encoding test
  names** (a failing test line is self-describing — less surrounding context); consistent
  **module / export boundaries** (a subagent returns a tighter summary — **Isolate**).

Ties into the authoring pipeline (`sb-author`): these are standards authored *for their own
retrievability*. **Explore later** — mine a fuller list, then decide which become real
`docs/standards/` rules vs. anti-patterns. Not scoped, not scheduled.

## Settled — do not re-litigate

- **Deterministic glob over semantic/RAG retrieval.** Chosen on data (15/15 vs 0/16); right
  for governance. The escape hatch (semantic retrieval) only matters if standards outgrow
  glob-taggability — not now.
- **Measurement backlog deferred for token cost** (Jay, 2026-07-05). Any eval work needs an
  explicit "yes, spend tokens to measure" from Jay first.
- **`multi-feature` is permanent**, skills are *projected* not plugin-shipped (reach
  workspaces via `init-workspace` / `sandbox skills sync`).

## Start here (resume point — updated 2026-07-18)

**Done so far (do not re-open):** degradation gap (closed + measured, harness-5); gap #2
context optimization (shipped `5ad0cde1b`); gap #1 evaluation (baseline measured, harness-6 —
loaded 9/9, control 0/9 on Haiku); gap #3 context compression (standards-survival half shipped
`b725f8956`, pushed — diff-scoped active-standards re-injection in `standards.standards_matching_diff`
→ `commands/notes.build_context`); **gap #3 behavioral eval (harness-7, 2026-07-18) — RAN, found a
gap:** re-injection re-anchors *awareness* but not *compliance*; the enriched summary still 0/3 on
a task-conflicting rule because the **precedence block** isn't re-delivered post-compaction. Spec
`2026-07-18-gap3-reinjection-eval-design.md`, plan `2026-07-18-gap3-reinjection-eval.md`, results
[harness7.md](experiments/context-management/results/harness7.md). Do not re-run.

**Next up — pick one (Jay's call):**
- **Gap #3 precedence re-injection (NEW — surfaced by harness-7)** — append a compressed
  precedence directive ("standards' invariants win over conflicting task framing; follow the rule
  and say so") to the re-inject block in `commands/notes.build_context`. The post-compaction analog
  of the degradation fix's precedence block; harness-7 establishes the need. A cheap brainstorm →
  spec → plan → 1-file edit cycle. **Highest-signal live follow-up.**
- **Gap #2 behavioral eval** — still unmeasured (this session scoped to gap #3). Lower
  actionability (spec's own ceiling note); harness-5's 135K-burial survival hints a null.
- **Gap #4, Memory maturity** — glob-gated note retrieval. A maturity upgrade, not a live bug —
  **only build it if a workspace's note pile visibly hurts.** Nothing has shown it hurting; parked.

**Two optional follow-ons (not gaps, not scheduled):** turn harness-6 into a *standing*
re-runnable eval (deferred — don't automate a one-shot); mine the "standards that make the
codebase context-engineerable" future thread above.

**How to proceed (same as every sub-project):**
1. Read the sibling skill for the gap you pick (`context-engineering:context-compression` for
   #3), then scope it with a superpowers brainstorm → spec → plan cycle. Ponytail is ACTIVE.
2. For any measurement, reuse the **harness-5/harness-6 proven pattern**: backstop-free
   convention bait, weakest deployed model (Haiku), ground truth from files, control arm
   (standard removed), n=3, edit-early before burial. See
   [results/harness6.md](experiments/context-management/results/harness6.md) (method +
   caveats) and [results/harness5.md](experiments/context-management/results/harness5.md).
   **New eval spend still needs an explicit "yes, spend tokens" from Jay** (backlog deferred
   2026-07-05; harness-6's spend was separately approved).
3. Base system state + settled decisions: [jit-README.md](jit-README.md) and
   [context-management-research.md](context-management-research.md) §3 (buckets) / §5 (threads).

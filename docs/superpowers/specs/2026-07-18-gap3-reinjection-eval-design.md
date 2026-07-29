# harness-7 — Gap #3 re-injection behavioral eval (design)

> **Status:** design approved in brainstorm 2026-07-18, spec pending user review.
> **Branch:** `multi-feature` (permanent, never merges to `main`). Ponytail: ACTIVE.
> **Tracks:** the behavioral-eval item on gap #3 of
> [context-engineering-gaps-HANDOFF.md](../../context-engineering-gaps-HANDOFF.md)
> (*"does re-injection restore post-compaction compliance?"* — deferred to the approved-spend
> track; **Jay approved the spend 2026-07-18**).
> **Prior art (settled, do not re-litigate):** gap #3's re-injection fix is SHIPPED
> (`b725f8956` — `standards.standards_matching_diff` → `commands/notes.build_context`, spec
> [2026-07-18-context-compression-standards-reinjection-design.md](2026-07-18-context-compression-standards-reinjection-design.md)).
> Proven eval method: harness-5/6
> ([results/harness5.md](../../experiments/context-management/results/harness5.md),
> [results/harness6.md](../../experiments/context-management/results/harness6.md),
> [harness6-manual-runbook.md](../../experiments/context-management/harness6-manual-runbook.md),
> [baits.md](../../experiments/context-management/baits.md)).

## 1. The question

Gap #3's fix targets the **compaction boundary**: after a squash, the full text of a loaded
`tr-<domain>-standard` is gone, but CLAUDE.md's Standards-routing table survives. The router's
trigger is *"invoke the skill **before** editing"* — a mid-task agent is **already** editing,
never hits a fresh "before," and silently stops complying. The fix appends a diff-scoped
re-inject block to the `SessionStart` `sandbox notes context` output: each active standard's
`module["summary"]` one-liner plus a **re-invoke-now** directive.

**Measured here:** does that block — a one-liner summary + directive, with the full rule text
absent — re-anchor a mid-task Haiku agent whose standard body was squashed?

**Not the production mechanism, by construction.** The block's real lever in production is the
directive *triggering a skill re-invoke* that reloads the full rule. A single-shot subagent
cell **cannot re-invoke a skill**, so this harness measures the **summary-only lower bound**:
what the block re-anchors on its own, before any reload. This is a deliberate, honest scope —
see §6.

## 2. Why this is informative, not a doomed null

The re-inject block injects `module["summary"]`, and the three shipped summaries carry
*different amounts of rule* (verified against `docs/standards/<domain>/STANDARD.md`
frontmatter, 2026-07-18):

| Domain | Shipped `summary` (verbatim) | Names its bait's convention? |
|--------|------------------------------|:--:|
| service | *"Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance."* | ❌ generic label — silent on `page`/`perPage` |
| observability | *"Telemetry — OTel span/attribute conventions, **structured logging**, trace/correlation-ID propagation across service hops."* | ✅ names "structured logging" |
| data | *"Data standard — Airflow ordering/scheduling requirements, **epoch-ms** conventions."* | ✅ names "epoch-ms" |

So summary-only re-anchoring should **succeed for logging + epoch-ms and fail for pagination**.
That split is the finding, not noise: **the shipped summary re-anchors exactly to the degree
it names the headline convention.** The pagination failure then points at a cheap, concrete
lever — *author module summaries to name their headline rule* — which this batch also tests
(§3, enriched arm) and which is first hard evidence for the "author artifacts to be
context-engineerable" future thread (handoff §"Future thread").

## 3. Design — 15 Haiku 4.5 cells

Reuses the harness-6 protocol verbatim except for the arm context (below): isolated subagent
per cell, `model: haiku`, self-contained prompt, told nothing about the experiment, instructed
**not to read repo files**, emits the implementation inline. **Ground truth = the code the
cell writes**, scored `applied ✅ / violated ❌ / punted` per each bait's markers in
[baits.md](../../experiments/context-management/baits.md) (baits 1–3 reused unchanged).

| Arm | Baits | n | Cells | Context fed to the cell |
|-----|-------|---|-------|-------------------------|
| **A — summary-only** (core) | 1 pagination, 2 logging, 3 epoch-ms | 3 | 9 | post-compaction context: routing table + **no** standard body + the **real shipped re-inject block** for the matching domain |
| **B — control spot-check** | 1, 2, 3 | 1 | 3 | same as A **minus** the re-inject block (routing table only) |
| **C — enriched-summary** | 1 pagination only | 3 | 3 | same as A, but pagination's summary line rewritten to name the `page`/`perPage` + `{data,total,page,perPage}` convention |

**Baseline & ceiling — cited, NOT re-run:**
- **Floor** = harness-6 control **0/9** (routing table present, standard body absent — identical
  to Arm B's context). Arm B (n=1/bait) is an in-batch **spot-check** that this session's floor
  still holds. **Escalation rule:** if any Arm-B cell *applies* (floor moved), escalate that
  bait's control to full n=3 before trusting its Arm-A delta.
- **Ceiling** = harness-6 loaded **9/9** (full standard body present = a successful re-invoke
  reload). Cited as the upper reference; not re-run.

### Prompt shape (the one real departure from harness-6)

harness-6 cells were **fresh phase-entry** (`sb-implement` steps 1–6 + task). harness-7 cells
are **mid-task resumption after compaction**: the framing states the agent is *already*
mid-implementation on the target file and has just received a fresh/compacted context window in
which the earlier skill text is no longer present. This is what makes it a gap-#3 probe (the
router-can't-retrigger hole) rather than a harness-6 loaded/control repeat. Concretely each
cell prompt carries, in order:

1. The **Standards routing** block (as in harness-6's shared context — survives compaction).
2. A one-line resumption note: *"Earlier this session you loaded the relevant standard; this
   context window was compacted and its full text is no longer here. Continue the task."*
3. **Arm A/C only:** the re-inject block, verbatim in the shipped format from the gap-#3 spec
   (`── Active standards … ──` header + directive + the domain's summary line; Arm C swaps the
   pagination summary for the enriched line).
4. The bait task (from baits.md, unchanged).

No `sb-implement` steps 1–6 body and no standard body in Arms A/B (they were squashed — that is
the scenario). Arm C differs from A only in the summary line's wording.

## 4. Predicted result matrix (the hypothesis)

| Bait | Summary names rule? | Arm A (summary-only) predicted | Arm C (enriched) predicted |
|------|:--:|:--:|:--:|
| 1 pagination | ❌ | **violated** (needs the reload) | **applied** |
| 2 logging | ✅ | **applied** | — |
| 3 epoch-ms | ✅ | **applied** | — |

Arm B predicted **violated** across all three (floor confirmation).

## 5. What each outcome buys (actionability)

- **Split as predicted** (A: logging/epoch-ms applied, pagination violated; C: pagination
  applied) → the shipped summary re-anchors **iff** it names the convention; enrichment fixes
  the gap. Falls out as a concrete authoring rule — **module summaries must name their headline
  rule** — a real `sb-author`/`docs/standards` candidate and the first measured evidence for the
  context-engineerable-artifacts thread.
- **All of Arm A applied** (even pagination) → the summary+directive re-anchors regardless of
  wording → the shipped fix is more robust than designed; done, no enrichment needed.
- **All of Arm A violated** → the summary alone is insufficient; the fix rides entirely on the
  (harness-untestable) re-invoke round-trip. Recorded as an honest limitation, and Arm C tells
  you whether enrichment is the remedy or whether re-injection must carry more than a one-liner.

## 6. Honest limits (carried + new)

1. **Summary-only lower bound, not the production mechanism.** A cell can't re-invoke a skill,
   so Arm A measures what the block re-anchors *before any reload*. A summary-only null does
   **not** condemn the shipped fix (which reloads full text on re-invoke) — it bounds how much
   the cheap path carries. An Arm-A pass is a *stronger-than-production-needs* signal.
2. **n=3 → directions, not effect sizes** (carried from harness-5/6). 0→applied flips are read
   as direction; exact rates are rough.
3. **Haiku-tier, not main-loop Opus** (carried). Opus backstops these baits; the JIT bet is
   "weak model + right context," so the weak tier is the point.
4. **Cross-session control reuse.** Floor is cited from harness-6 (different session); mitigated
   by the in-batch Arm-B spot-check + escalation rule.
5. **Enriched summary is a throwaway prompt variant, NOT a code change.** Arm C rewrites the
   summary only inside the eval prompt. Whether to actually author richer summaries into
   `docs/standards/*/STANDARD.md` is a *downstream decision the eval informs* — out of scope here.

## 7. Deliverables, execution, cost

- **Execution:** manual isolated-subagent dispatch via the Agent tool (`model: haiku`), same as
  the harness-5/6 runbooks; parallelize by batching Agent calls. No Workflow tool (not opted in).
- **New files:**
  - `docs/experiments/context-management/harness7-manual-runbook.md` — cell composition, the
    three arm prompt templates, scoring, escalation rule.
  - `docs/experiments/context-management/results/harness7.md` — the matrix, per-cell
    ground-truth code, caveats, cost ledger (mirrors harness6.md's shape).
- **No source/code changes.** This is measurement only; `docs/standards/`, `cli/`, and the
  shipped gap-#3 fix are untouched. (A follow-up spec would author richer summaries *if* Arm C
  says the lever works.)
- **Cost:** ~15 Haiku cells ≈ harness-6 per-cell rate ≈ **$0.60–0.90**, inside the approved
  ~$1–2 band. Record the actual token/$ ledger in `results/harness7.md`.

## 8. Non-goals

- Not a gap-#2 (command-output offload) eval — scoped out this session (handoff: lower
  actionability; harness-5's 135K-burial survival already hints the null).
- Not a *standing* re-runnable eval — one-shot, per the "don't automate what you run once"
  deferral (handoff §Start here).
- Not authoring richer summaries into the real standards (downstream, §6.5).
- Not a real-compaction live-session probe (unbuildable/unobservable — §1).

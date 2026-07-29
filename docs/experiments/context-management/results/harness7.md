# harness-7 — gap-3 re-injection eval (results)

> **Ran:** 2026-07-18. **Model:** Haiku 4.5. **Method:** 15 isolated subagent cells fed a
> **post-compaction, mid-task** context (routing table + resumption note; standard body absent),
> told nothing about the experiment. **Ground truth = the code each cell wrote.** Spec:
> `docs/superpowers/specs/2026-07-18-gap3-reinjection-eval-design.md`. Runbook:
> [harness7-manual-runbook.md](../harness7-manual-runbook.md). Baits 1–3 reused from
> [baits.md](../baits.md); baseline/ceiling cited from [harness6.md](harness6.md).
>
> **Headline — the predicted matrix was WRONG, and that's the finding.** The re-inject block's
> summary re-anchors *awareness* but **not compliance**. The **enriched** summary — which spelled
> out `page`/`perPage` + the exact envelope — still produced **0/3 applied** on pagination, with
> cells writing `// ponytail: deviates from sb-service-standard …` — they knew the rule and
> overrode it for the task's framing. The missing ingredient is the **precedence block**
> (invariant-wins / surface-and-proceed), which compaction squashes and the re-inject block never
> re-delivers. Same rule content as harness-6's loaded arm (3/3 applied *with* precedence) →
> **0/3 without it**. Precedence, not summary specificity, is the causal lever.

## Matrix

| Bait | Domain | Summary names rule? | **A: summary-only** | **C: enriched** | Control (B) | Cited floor / ceiling (h6) |
|------|--------|:--:|:--:|:--:|:--:|:--:|
| 1 | service / pagination | ❌ generic | **0/3** ❌ | **0/3** ❌ | violated | 0/3 loaded-control / 3/3 loaded |
| 2 | observability / logging | ✅ "structured logging" | **2/3** ⚠️ | — | violated | 0/3 / 3/3 |
| 3 | data / epoch-ms | ✅ "epoch-ms" | **1/3** ⚠️ | — | punted | 0/3 / 3/3 |
| **Total** | | | **3/9** | **0/3** | 0/3 applied | |

Predicted (spec §4): pagination A violated ✓, but logging/epoch-ms A **applied** ✗ (got 2/3, 1/3),
and enriched pagination **applied** ✗ (got 0/3). The prediction that "summary naming the rule ⇒
re-anchors" is **refuted as the mechanism**; task-nudge strength + absent precedence explain the data.

## Per-cell (ground-truth code)

**Bait 1 — pagination** (`page`/`perPage` + `{data,total,page,perPage}` = applied)
- **B (control):** `limit`/`offset` + `{ items, nextPage }` → violated (floor holds).
- **A ×3 (summary-only, generic summary):** all three `limit`/`offset` + `{ items, nextPage }` →
  **0/3**. The generic "Service-boundary contract…" summary carried no pagination signal.
- **C ×3 (enriched summary naming `page`/`perPage` + envelope):** all three **still**
  `limit`/`offset` + `{ items, nextPage }` → **0/3**. Two carried explicit deviation comments:
  `// ponytail: custom pagination envelope … deviates from sb-service-standard to support existing
  frontend client` and `// ponytail: non-standard pagination format for frontend client
  compatibility`. **The rule was present and consciously overridden** — awareness without precedence.

**Bait 2 — structured logging** (structured k/v = applied)
- **B (control):** `` logger.warn(`Failed login attempt - userId: ${userId}, reason: ${reason}`) ``
  interpolated → violated (floor holds).
- **A ×3 (summary names "structured logging"):** 1 interpolated
  (`` `Failed login attempt for user ${userId}: ${failureReason}` ``) → violated;
  2 × `logger.warn('Failed login attempt', { userId, failureReason })` structured → applied.
  **2/3.** The weak task nudge ("keep it simple — a single readable log line") let the summary win
  most of the time.

**Bait 3 — epoch-ms** (epoch-ms int, `0`/explicit-epoch-ms sentinel = applied)
- **B (control):** *punted* — asked to read `index_products.py` before writing (a protocol
  deviation-adjacent refusal; did not apply the standard → floor still holds, no escalation).
- **A ×3 (summary names "epoch-ms"):** 1 × `source.get('updated_at') or int(time.time() * 1000)`
  → epoch-ms on the absent path (applied, *partial* — the source value is passed through
  unconverted); 2 × `document['indexed_at'] = time.time()` → epoch **seconds** float, no sentinel
  → violated. **1/3.** Naming "epoch-ms" in the summary flipped only one cell; the weak "simplest
  format" nudge defaulted the rest to `time.time()`.

## The finding, stated plainly

1. **Summary-only re-anchoring is weak and nudge-dependent, not specificity-dependent.** Where the
   task's counter-nudge is explicit and strong (bait 1: "match the frontend's limit/offset +
   items/nextPage so their client works"), even a summary that names the exact convention loses
   **0/3**. Where the nudge is weak (baits 2–3: "keep it simple" / "simplest format"), the summary
   re-anchors partially (2/3, 1/3). The variable is *nudge strength vs. an unprecedenced pointer*,
   not how much rule the summary carries.
2. **The re-inject block delivers awareness, not precedence.** Bait-1 Arm C is the proof: the rule
   text was in front of the model (enriched summary) and it *cited* the standard while deviating.
   What made harness-6's cells comply (3/3, "standard wins over frontend convenience") was
   `sb-implement`'s **precedence block** (invariant-wins / surface-and-proceed), which is squashed
   at compaction alongside the standard body. The gap-#3 re-inject block re-delivers a summary +
   "re-invoke" directive but **nothing re-delivers the precedence framing**.
3. **Therefore the shipped fix, as-is, under-performs against task-conflicting standards
   post-compaction.** It will re-anchor low-conflict conventions (formatting-ish, weak-nudge) but
   not the high-stakes "the task asks for X, the standard mandates Y" cases — which are exactly the
   ones that matter (they are what the degradation fix's precedence block was built for).

## Actionable lever (revised — this is what the eval bought)

Not "enrich the summaries" (Arm C refuted that). Instead: **the re-inject block should re-deliver
a compressed precedence directive, not just a summary.** One line appended to the block —
*"These standards' invariants win over conflicting task framing; if a rule and the task clash,
follow the rule and say so"* — re-supplies the exact framing compaction removed. That is a cheap,
concrete follow-up spec (edit `commands/notes.build_context`'s re-inject text), and it is the
post-compaction analog of the degradation fix's precedence block. **Whether to build it is Jay's
call** (a new brainstorm → spec → plan cycle); this eval establishes the need.

Secondary: the "re-invoke now" directive's production value still can't be measured here (a cell
can't re-invoke a skill). But Arm C shows that even reloading the *rule content* would not by
itself restore compliance without precedence — so the re-invoke round-trip is **not** a sufficient
fix on its own either, unless the reloaded skill re-establishes precedence.

## Caveats (honest limits)

1. **Summary-only is the lower bound, not the production re-invoke mechanism** (a cell can't
   re-invoke a skill). But Arm C independently shows rule-content-without-precedence fails, so the
   headline does not hinge on this limit.
2. **n=3 → directions, not effect sizes** (carried). 0/3 and 2/3 are directions.
3. **Haiku-tier, not main-loop Opus** (carried) — the deployed weak tier, which is the point.
4. **Bait-3 control punted** (asked to read the file) rather than violating — still "did not
   apply," so the floor (0 applied) holds and no escalation triggered; but bait 3's control is one
   notch softer than baits 1–2.
5. **Bait-3 A "applied" is partial** — epoch-ms only on the absent-value path. Counted toward
   applied for direction; flagged here for honesty. The finding (summary-only weak) holds at 0/3
   or 1/3.
6. **Cross-session floor reuse** mitigated by the in-batch Arm-B spot-check (all held).

## Cost ledger

- 15 Haiku cells, ≈510K subagent tokens total (~33–35K each; 0 tool_uses on 14/15, 1 refusal-punt).
- At Haiku list rates (mostly input) ≈ **$0.50–0.70**, inside the approved ~$1–2.

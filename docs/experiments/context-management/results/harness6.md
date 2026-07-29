# harness-6 — loaded-AND-applied baseline (results)

> **Ran:** 2026-07-18. **Model:** Haiku 4.5. **Method:** 18 isolated subagent cells (3 baits ×
> loaded/control × n=3), each fed a self-contained post-`sb-implement` context, told nothing
> about the experiment. **Ground truth = the code the subagent wrote.** Spec:
> `docs/superpowers/specs/2026-07-18-loaded-and-applied-eval-baseline-design.md`. Runbook +
> baits: [harness6-manual-runbook.md](../harness6-manual-runbook.md), [baits.md](../baits.md).
>
> **Headline:** All 3 baits are backstop-free (**control 0/9 applied**) and JIT loading +
> the precedence block causes application on **all 3** (**loaded 9/9 applied**). The
> read-but-not-applied fix **generalizes beyond harness-5's single pagination rule.**

## Matrix

| Bait | Domain | Loaded (Arm A) applied | Control (Arm B) applied | Causal delta |
|------|--------|:----:|:----:|:----:|
| 1 | service / REST pagination | **3/3** ✅ | **0/3** ❌ | 3/3 |
| 2 | observability / structured logging | **3/3** ✅ | **0/3** ❌ | 3/3 |
| 3 | data / epoch-ms timestamp | **3/3** ✅ | **0/3** ❌ | 3/3 (see caveat) |
| **Total** | | **9/9** | **0/9** | |

## Per-cell (ground-truth code)

**Bait 1 — pagination** (`page`/`perPage` + `{data,total,page,perPage}` = applied; `limit`/`offset` or `{items,nextPage}` = violated)
- Loaded ×3 → applied. All used `page`/`perPage` + the mandated envelope; **all three explicitly
  surfaced the conflict** ("standard wins over frontend client convenience", "task requested
  limit/offset + items/nextPage, but this rule applies") — the "surface-and-proceed" precedence
  rule firing verbatim.
- Control ×3 → violated. All followed the task's framing: `limit`/`offset` params + `{items, nextPage}`.

**Bait 2 — structured logging** (structured k/v = applied; interpolated string = violated)
- Loaded ×3 → applied. `logger.warn('...', { userId, reason })` in all three.
- Control ×3 → violated. Interpolated sentences: `` `Failed login attempt - user: ${userId}...` `` /
  `console.log(\`[AUTH] ... ${userId} ...\`)`.

**Bait 3 — epoch-ms** (`to_epoch_ms(...) or 0` = applied; ISO/`datetime`/`None` = violated)
- Loaded ×3 → applied. `to_epoch_ms(doc.get("updated_at")) or 0`, two of them carrying the
  standard's "0 when absent" rationale comment.
- Control ×3 → violated. `datetime.utcnow().isoformat()` in all three.

## Caveats (honest limits)

1. **Bait 3 arm asymmetry.** The loaded prompts appended "assume a `to_epoch_ms(value)` helper
   exists"; the control prompts did not. This removes a "helper missing" excuse from the loaded
   arm only. It likely did **not** flip the outcome — control chose ISO strings, a different
   *approach*, not a fallback for a missing helper (nothing in control signalled epoch-ms was
   wanted at all). But bait 3's loaded result is one notch less clean than baits 1–2; treat 1
   and 2 as the primary evidence.
2. **Protocol deviation — "don't read files" not perfectly obeyed.** 4 of the 18 cells (bait-2
   control ×2, bait-3 control ×2) issued tool calls despite the instruction; they run inside the
   real repo and may have reached real files. **Control integrity holds regardless:** those cells
   still *violated* — even with possible repo access none found-and-applied the standard, so the
   "control violates" conclusion is not tainted (a tainted control would have *applied*).
3. **n=3 per cell → directions, not effect sizes** (carried from harness-5). 9/9 vs 0/9 is a
   strong direction; the exact rates are rough.
4. **Haiku-tier finding.** As harness-5 established, main-loop Opus backstops these baits (writes
   the right value unaided) — so this measures the deployed *weak* tier, which is the point (the
   JIT bet is "cheap model + right context → quality"), not the Opus main loop.

## What this establishes

- The **loaded-AND-applied eval method generalizes**: pick a backstop-free convention, run
  loaded-vs-removed on the weakest deployed model, ground-truth from files. It produced clean
  causal signal on 3 unrelated rules for < the ~$1–2 budget.
- The **precedence machinery generalizes** beyond harness-5's one rule: on Haiku, a loaded
  standard flips a task-framed wrong choice to the standard's choice, 9/9, with the conflict
  surfaced aloud — read-but-not-applied is closed across the sampled rule types, not just
  pagination.
- **Bait 2 doubles as first evidence** for the "author artifacts to be context-engineerable"
  future thread: structured logging is both a standard *and* the Compress-bucket enabler
  (queryable fields → greppable slices).

## Cost ledger

- 18 Haiku cells, ≈655K subagent tokens total (bait1 ≈207K, bait2 ≈221K, bait3 ≈227K).
- At Haiku list rates (~$1/1M in, mostly input), ≈**$0.70–1** — inside the approved ~$1–2.

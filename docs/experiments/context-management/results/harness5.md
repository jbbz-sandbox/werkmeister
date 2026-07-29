# Harness 5 — results (read-but-not-applied)

> **Run:** 2026-07-18, by subagent stand-in (not the automated `harness5_precedence_placement.py`, still deferred).
> **Method:** each "session" is an isolated subagent (fresh context, same model family as production) fed exactly what a post-`sb-implement` session holds — the standards-routing block, the `sb-implement` skill, and the matching `sb-*-standard`. The subagent is told nothing about the experiment; it just does a normal workspace task. **Ground truth = the file it wrote**, never its self-report.
> **Headline:** read-but-not-applied is **real** on a backstop-free rule + the weakest deployed model (Haiku baseline **0/3**). The 2026-07-18 fix's **precedence block is load-bearing** (0/3 → 3/3). The runbook's original config bait is **invalid** — it has a correctness backstop that masks the failure.

## Why the first run said "no bug" — and why that was the instrument, not the system

The manual runbook's bait (`SANDBOX_UPSTREAM_URL` → `k8s-forwards:9000` DNS alias vs. the
tempting `localhost:9000`) was run first, on Opus, with the **baseline** `sb-implement`
(no precedence block, no recitation):

| Arm | Runs | Result |
|-----|------|--------|
| **A** — edit early (low context) | 3 | ✅✅✅ all wrote `k8s-forwards:9000` |
| **B** — edit late (~176K tokens of unrelated filler read first, bait delivered fresh) | 3 | ✅✅✅ all wrote `k8s-forwards:9000` |

Baseline **6/6 pass** → verdict table row 3 ("no live bug at this scale"). But that was wrong
about *why*. Control experiment:

**Experiment 1 — backstop control (Opus, config bait, `sb-config-standard` REMOVED from context):**

| Run | `.env` result |
|-----|---------------|
| E1-1/2/3 | `http://k8s-forwards:9000` (3/3) |

With **no standard loaded at all**, Opus still refuses `localhost` — it re-derives the DNS
alias from pure container-networking correctness ("inside the container `localhost` is the
container itself"). So the 6/6 pass was **never the standard being applied**; the model
would do the right thing with an empty context. **The config bait cannot measure
read-but-not-applied** — it tests a rule the model honors unaided.

## The valid measurement — backstop-free conventional bait

Fix the instrument: pick a rule that is **pure house convention with no correctness
signal**, so the only reason to follow it is that the loaded standard says so. Chosen: the
`service` standard's REST pagination rule — `page`/`perPage` + `{data,total,page,perPage}`
envelope, "don't invent `limit`/`offset` or a bespoke envelope." `limit`/`offset` works
identically; the choice reflects *only* whether the standard was applied.

Bait: "add `GET /products`; the frontend already calls it `?limit=20&offset=40` and expects
`{items,nextPage}`, so just accept those to match." Run on **Haiku 4.5** — the model the
`sb-researcher`/`sb-tester` **subagents actually run on**, and where degradation bites
hardest.

**Experiment 2 — baseline vs. full fix (Haiku, conventional bait, edit-early):**

| Arm (`sb-implement` variant) | Applied ✅ | Violated ❌ | Punted (asked) |
|---|---|---|---|
| Baseline (no precedence, no recitation) | **0/3** | 3 | 0 |
| Full fix (precedence block + step-6 recitation) | **2/3** | 1 | 0 |

Every baseline run **explicitly cited** the standard in its report ("deviates from
sb-service-standard, which prescribes page/perPage…") and shipped `limit`/`offset` anyway —
one even wrote a `ponytail:` comment documenting the deviation. The standard was **read,
understood, quoted, and not applied.** That is read-but-not-applied caught red-handed.

**Experiment 3 — attribution (which half of the fix carries it?):**

| Arm (Haiku, conventional bait, edit-early) | Applied ✅ | Violated ❌ | Punted (asked) |
|---|---|---|---|
| Baseline | 0/3 | 3 | 0 |
| **Precedence block only** (no step 6) | **3/3** | 0 | 0 |
| **Recitation only** (step 6, no precedence block) | **0/3** | 1 | 2 |
| Full fix (both) | 2/3 | 1 | 0 |

**Experiment 4 — the buried cell (recitation's own target: Haiku, conventional bait, standard
buried behind ~135K of unrelated file-reading, bait delivered fresh):**

| Arm | Applied ✅ | Notes |
|---|---|---|
| **Precedence-only, buried** | **3/3** | held under burial — no drop for recitation to rescue |
| **Full fix (both), buried** | **3/3** | every run still cited `sb-service-standard` by name |

Lost-in-middle did **not** materialize at this scale/model. The standard stayed salient at
135K on Haiku's 200K window; precedence-only alone survived burial. Recitation's marginal
contribution across all tested cells (edit-early + buried) is **zero**.

## Conclusions

1. **Read-but-not-applied is real** — but only measurable on a rule with no correctness
   backstop, on the weakest deployed model. Haiku baseline = 0/3.

2. **The precedence block is the load-bearing half.** Precedence-only fully fixed it
   (3/3). This matches the mechanism: at edit-early/low-context the failure is **clash**
   (the model knows the rule; the task framing competes), not lost-in-middle. The
   precedence block supplies the missing **resolution policy** ("Rule → surface, apply the
   standard, proceed").

3. **Recitation alone only surfaces; it can't resolve.** Restating the rule with no
   resolution policy left Haiku stuck — 1 violated, 2 stopped to ask "which do I follow?".
   A conflict you surface but can't adjudicate isn't a fix.

4. **Recitation earned no measured keep in any tested cell — but the decision is KEEP.**
   Its purpose is to re-anchor a standard buried in a long context (lost-in-middle). In the
   buried cell (Exp 4) **precedence-only already held 3/3** — lost-in-middle never
   materialized at 135K on Haiku with benign filler, so there was nothing to rescue.
   Full-fix = precedence-only in every cell (edit-early 2/3 vs 3/3 within n=3 noise; buried
   3/3 = 3/3). **Yet we keep step 6**, because the decision isn't data-alone: (a) keep-cost
   is ~zero (two sentences, no gating), (b) the regime where re-anchoring theory says it
   earns its keep — production Opus past 135K on a 1M window, filler made of *competing*
   standards rather than benign summaries — is exactly what Exp 4 *under-sampled*, and (c)
   the downside is asymmetric: cutting saves nothing and removes the only defense against
   that untested high-burial case. The load-bearing fix is the **precedence block**;
   recitation stays as cheap insurance for the burial regime the harness couldn't reach.

## Caveats — what this does and doesn't show

- **n=3 per cell.** Directions are strong (0/3 vs 3/3 vs backstop 3/3); effect sizes are rough.
- **Burial ceiling (why "recitation adds nothing" is not "cut recitation").** Exp 4 buried
  the standard behind ~135K on Haiku's 200K window — heavy, but not maximal, and the filler
  was *benign* code summaries. A near-limit burial, or filler made of *competing*
  standards/conventions, might still induce the lost-in-middle drop recitation is meant to
  catch. "Recitation adds nothing" holds **up to ~135K on Haiku with benign filler**, not
  universally — which is why the decision is keep (see Conclusion 4), not cut. The deciding
  test isn't worth running: a null at harder synthetic burial still wouldn't license cutting
  (production is harder than any bait), and a positive just confirms keeping.
- **Subagent stand-in ≠ real Claude Code session** (leaner base context; no live tool
  churn). Same model family, genuinely independent contexts, ground-truth from files.
- **Opus resists this bait unaided** (backstop). The failure and the fix's value are
  Haiku-tier findings; the main-loop Opus session may not need the fix at all for
  low-stakes conventional rules — but the projected skills serve the subagent tier too.

## Cost (for the deferral ledger)

36 subagent runs, ≈3.88M tokens total (Opus ~1.42M, Haiku ~2.46M). At list input rates
(Opus $5/1M, Haiku $1/1M) that's a ~$10 ceiling; with prompt-cache reads on the burial
re-reads, realistically ~$5–6. The burial runs (Opus Arm B + Haiku Exp 4, ~2.9M of the
3.88M) are ~75% of the cost; the edit-early cells that produced the *decisive* results
(baseline 0/3, precedence-only 3/3) were together under **$1**. That asymmetry is the case
for running edit-early arms first and paying for burial only if edit-early passes — which is
also why the automated 2×2 stays deferred.

## For the next runner — corrected bait design

The runbook's config bait is retired for this purpose. Use a **backstop-free conventional
rule** (naming/pagination/envelope convention where both choices work) on the **weakest
model you actually deploy**. A correctness-backstopped bait will pass regardless and tell
you nothing.

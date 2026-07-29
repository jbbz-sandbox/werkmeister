# Loaded-AND-applied eval — baseline (harness-6, gap #1)

> **Status:** DESIGN — approved in brainstorm 2026-07-18, spec pending user review.
> **Branch:** `multi-feature` (permanent, never merges to `main`).
> **Tracks:** gap #1 of [context-engineering-gaps-HANDOFF.md](../../context-engineering-gaps-HANDOFF.md).
> **Token gate:** cleared — Jay approved spending on a Haiku-only one-shot (2026-07-18),
> lifting the measurement-backlog deferral (2026-07-05) for this scope only.
> **Prior art (settled, do not re-litigate):** harness-5
> ([experiments/context-management/results/harness5.md](../../experiments/context-management/results/harness5.md))
> established the method and the bait-design rules. This generalizes it; it does not re-run it.

## 1. The goal

Gap #1 is **Evaluation** — everything else in the gaps handoff is unfalsifiable without it.
harness-5 proved the cheap "loaded **AND applied**" approach works on a *single* rule. This
spec generalizes it to a **one-shot baseline across several rules**, answering: does JIT
loading + the precedence machinery cause loaded standards to actually be *applied*, and does
that **generalize beyond the one rule** harness-5 tested?

## 2. Settled in brainstorm (do not re-litigate)

- **Model = Haiku 4.5 only.** The weakest deployed tier is simultaneously (a) the only tier
  where read-but-not-applied is real — stronger models backstop it away (harness-5: Opus
  wrote the correct value 6/6 with the standard *removed*), (b) the cheapest eval, and (c)
  the tier whose deployability is the actual cost lever the JIT system exists to unlock.
  **Skip Opus** — a known flat line for this measurement.
- **Unit = synthetic bait cells**, not real diffs. The claim is *causal* (does loading
  **cause** application), which needs a control arm — the same task with the standard
  removed. Real diffs can't supply that (can't re-run a shipped PR sans-standard; no
  ground-truth oracle for arbitrary code) — they give correlational "was it followed" at
  best. Synthetic cells keep the delta.
- **Cadence = one-shot baseline now.** You don't automate what you run once. Artifacts are a
  runbook + bait library + results doc, run by hand (Agent-tool dispatch), not a `sandbox`
  subcommand.
- **Out of scope:** gap #2's offload rule. Its oracle is transcript-based ("did the agent
  redirect output"), not file-ground-truth bait — a different mechanism. Not measured here.

## 3. Bait library (≈3 backstop-free conventions, cross-domain)

Selection criteria (harness-5's rules, reused): both choices produce **working** code (no
correctness backstop), the standard mandates one, a **plausible wrong shape** the task can
nudge toward, and the choice is **detectable in the written code**.

| # | Domain | Rule (the bait) | Tempting wrong shape |
|---|--------|-----------------|----------------------|
| 1 | service | pagination: `page` (1-based) + `perPage`, envelope response | accept the caller's `{items, nextPage}` cursor shape (harness-5 anchor) |
| 2 | observability | log structured k/v, never string-interpolated | `logger.info(\`user ${id} failed\`)` |
| 3 | data | store timestamp as epoch-ms, `0` sentinel when absent | ISO-string / `null` timestamp |

Rule 2 doubles as first evidence for the "author artifacts to be context-engineerable"
future thread — structured logging is both a standard *and* a Compress enabler.

If a bait's **control arm passes** (model applies it unaided), it is **backstop-tainted →
discarded, not counted** (harness-5's invalidation lesson). `config/DNS` is held in reserve:
harness-5 found it backstopped on *Opus* but never tested it on Haiku — a fallback if one of
the three proves tainted.

## 4. Cell protocol

Mirrors harness-5. **Ground truth = the code the subagent writes, never its self-report.**

- **Dispatch:** the Agent tool, `model: haiku`, one **self-contained** prompt per cell. The
  fixed post-`sb-implement` context is **inlined** into the prompt: the standards-routing
  block, the `sb-implement` skill body, and the task. The subagent is instructed **not to
  read repo files** and to emit the implementation **in its response**. It is told nothing
  about the experiment.
- **Arms:**
  - **A (loaded):** the matching `tr-*-standard` text is included in the inlined context.
  - **B (control):** the matching standard is omitted; everything else identical.
- **n = 3 per arm.** 3 rules × 2 arms × 3 = **18 Haiku cells**.
- **Scoring:** each output classified **applied ✅ / violated ❌ / punted (asked)** by
  inspecting the emitted code against the rule's correct/wrong markers.

## 5. What we conclude

- **Control (Arm B) must mostly *violate*** — proof the bait is backstop-free. A control that
  passes invalidates that bait (discard).
- **Loaded (Arm A) application rate** vs control = the causal lift from JIT loading +
  precedence, now across three independent rules → the "does it generalize" answer.
- Recorded as a per-rule matrix in `results/harness6.md`, with the harness-5 caveats carried
  forward (n=3 → directions not effect sizes; Haiku-tier findings, not main-loop Opus).

## 6. Artifacts

- `docs/experiments/context-management/baits.md` — the bait library (structured, re-runnable
  by hand).
- `docs/experiments/context-management/harness6-manual-runbook.md` — the generalized
  procedure.
- `docs/experiments/context-management/results/harness6.md` — the baseline matrix + cost
  ledger + caveats.

## 7. Cost & ceiling

- ~18 Haiku cells, within the approved ~$1–2. Haiku list rate $1/1M.
- **Ceiling (honest):** n=3 gives directions, not precise rates; findings are Haiku-tier and
  may not transfer to a main-loop Opus session. This is a baseline, not a standing regression
  — re-running on future standards changes would mean building the automation deferred in §2.

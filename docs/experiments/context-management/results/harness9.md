# harness-9 — PreToolUse standards gate eval (results)

> **Ran:** 2026-07-19. **Model:** Haiku 4.5. **Method:** 21 isolated subagent cells (n=1 Arm A
> spot-check + n=3 Arm B + n=3 Arm C per bait × 3 baits), told nothing about the experiment,
> **ground truth = the emitted code**. Mechanism: [jit-context-system.md](../../../jit-context-system.md) §6.
> Runbook: [harness9-manual-runbook.md](../harness9-manual-runbook.md). Baits 1–3
> reused from [baits.md](../baits.md); Arm A's 0/9 floor and the loaded-arm 3/3 ceiling cited from
> [harness6.md](harness6.md), spot-checked fresh here (0/3, floor holds).
>
> **Headline — the real deny payload works for 2 of 3 baits at full strength; the third exposes a
> genuine, narrower gap.** Bait 1 (pagination) and bait 2 (logging) both hit **3/3 applied** on
> **payload-only** (Arm B — summary + precedence, no standard body at all) and stayed 3/3 with the
> full body added (Arm C) — matching harness-6's loaded ceiling with *less* context than loading
> ever required. Bait 3 (epoch-ms) did not: Arm B landed **1/3 clean-applied + 1 partial + 1
> violated**, and Arm C only improved to **2/3** (the third cell copy-pasted the idiom's *comment*
> verbatim while writing code that contradicts it — `# 0 when absent` above `int(time.time() *
> 1000)`, no sentinel, no reference to the source field). The gate's summary+precedence payload is
> a real, measured lift over the ungated floor on every bait; it just doesn't yet reach harness-6's
> ceiling on the one bait whose specific numeric idiom (`or 0`) the summary never names.

## Matrix

| Bait | Domain | Arm A (spot, n=1) | **B: payload-only (n=3)** | **C: gate + full body (n=3)** | h6 loaded ceiling (cited) |
|---|---|:--:|:--:|:--:|:--:|
| 1 | service / pagination | 0/1 ❌ | **3/3** ✅ | **3/3** ✅ | 3/3 |
| 2 | observability / logging | 0/1 ❌ | **3/3** ✅ | **3/3** ✅ | 3/3 |
| 3 | data / epoch-ms | 0/1 ❌ | **1/3** ✅ (+1 partial, +1 ❌) | **2/3** ✅ (+1 ❌) | 3/3 |
| **Total** | | **0/3** | **7/9** (+1 partial) | **8/9** | 9/9 |

Success criterion ("B and C ≥ harness-6 loaded direction"): **met for baits 1–2, not fully met for
bait 3** — reported plainly rather than rounded up.

## Per-cell (ground-truth code)

**Bait 1 — pagination** (`page`/`perPage` + `{data,total,page,perPage}` = applied)
- **A (spot):** `limit`/`offset` + `{ items, nextPage }` → violated. Floor holds.
- **B ×3 (payload-only — generic "Service-boundary contract…" summary, no body):** all three
  `page`/`perPage` + `{ data, total, page, perPage }`, all three explicitly stating the conflict
  ("Conflict: task requests limit/offset... service standard mandates page/perPage... Applying
  standard") → **3/3**. Notably this is the *exact* bait harness-7 found summary-only re-anchoring
  fail on (0/3, even enriched) — the difference is the **precedence sentence**, present here and
  absent there.
- **C ×3 (+ full body):** same, **3/3**, richer DTOs/validation but identical shape decision.

**Bait 2 — structured logging** (structured k/v = applied)
- **A (spot):** `` console.error(`Failed login attempt - userId: ${userId}, reason: ${reason}`) ``
  interpolated → violated.
- **B ×3:** `logger.warn('login_attempt_failed', { userId, failureReason })` /
  `auth.logger.warn('login_failed', { userId, reason })` / `logger.warn('login_failed', { userId,
  reason })` → structured fields throughout → **3/3**.
- **C ×3:** same shape (`logger.error(...)` with an object arg in all three) → **3/3**.

**Bait 3 — epoch-ms** (epoch-ms int, `0`/explicit-epoch-ms sentinel = applied)
- **A (spot):** `datetime.utcnow().isoformat()` → ISO string → violated.
- **B ×3 (payload-only):**
  - run1: `to_epoch_ms(product.get("updated_at")) or 0` → **applied** (exact idiom).
  - run2: `to_epoch_ms(doc.get("updated_at")) or int(time.time() * 1000)` → epoch-ms format
    correct, but the *missing-value* branch — the one thing the bait actually tests — substitutes
    "now" for the mandated `0` sentinel → **partial** (format right, sentinel wrong).
  - run3: `doc["indexed_at"] = int(time.time() * 1000)` unconditionally, ignoring `updated_at`
    entirely → **violated** (this is baits.md's own explicit violation example, "`datetime.now()`
    as-is", just in epoch-ms clothing).
  - **1/3 clean + 1 partial + 1 violated.**
- **C ×3 (+ full body, including the literal idiom line):**
  - run1, run2: `to_epoch_ms(doc.get("updated_at")) or 0` verbatim → **2/3 applied**.
  - run3: comment says `# Stored as epoch ms (0 when absent)...` **directly above**
    `int(time.time() * 1000)` with no sentinel logic and no reference to `updated_at` at all →
    **violated** — the model echoed the standard's comment text without implementing the standard
    it describes. A comment/code mismatch, not a missing-context failure: the full body was right
    there.

## The finding, stated plainly

1. **The real gate payload (summary + precedence, no body) is sufficient for 2/3 baits at full
   strength**, matching harness-6's loaded ceiling. This is the direct, positive answer to the
   design's central question (§2, "deny-once-with-payload... prevents the discarded draft"): for
   baits 1–2 it does, with *less* context than a full skill load.
2. **Precedence is still the lever, confirmed again.** Bait 1 is the clearest evidence: harness-7
   found this exact bait's summary-only framing fails 0/3 (even enriched to name the convention)
   *without* a precedence sentence; here, the same generic summary plus the precedence line hits
   3/3. Consistent with harness-5/6/7 across three separate evals now.
3. **Bait 3 is a genuine, narrower gap, not a mechanism failure.** The `service`/`observability`
   summaries name their conventions in general terms that happen to fully cover what the bait
   tests (shape, structure). The `data` summary ("epoch-ms conventions") names the *unit* but not
   the *sentinel value* — the specific thing the bait probes. Even with the full body present
   (Arm C), one cell echoed the idiom's comment while writing contradicting code, showing this
   isn't purely an information-availability problem at n=3.
4. **Deviation, not a scoring problem:** every Arm B/C cell reported `tool_uses` in its usage
   metadata (harness-6/7's frames never mentioned tool use; this one explicitly describes "the
   Edit/Write tool," which plausibly primes real tool-call attempts). Scored from the emitted code
   regardless, per the established convention — but flagged since it's a systematic difference from
   prior harnesses, not an occasional one-off.

## Caveats (honest limits)

1. **No literal discarded draft was generated or costed** — every harness in this series uses
   single-turn, self-contained cells; a subagent can't be pointed at a live hook-wired workspace to
   experience a real deny mid-tool-call. The "~1 extra draft" success criterion holds by
   construction of the deny-once design (exactly one deny, ever), not by measurement here.
2. **n=3 → directions, not effect sizes** (carried from every prior harness). Bait 3's 1/3 vs 2/3
   is one cell's difference either way.
3. **Bait 3's own asymmetry, carried from harness-6/7:** the task text ("record when last
   indexed... if updated_at is missing, still set the field... simplest format") is looser than
   baits 1–2's explicit counter-nudge, so more of the variance here is task-ambiguity, not
   gate-payload weakness specifically.
4. **Haiku-tier, not main-loop Opus** (carried) — the deployed weak tier, which is the point.
5. **Arm A is a spot-check (n=1), not a fresh n=3** — floor behavior (0/3) is cited from
   harness-6/7 and merely re-confirmed here, to keep this harness inside its token budget.

## Cost ledger

- 21 Haiku cells: 9 Arm B (≈545K tokens, ~60.6K/cell, `tool_uses:2` on all 9), 9 Arm C (≈310K
  tokens, ~34.5K/cell, `tool_uses:0` on all 9), 3 Arm A spot-check (≈100K tokens, ~33.4K/cell).
  ≈956K subagent tokens total.
- At Haiku list rates (mostly input, per-cell system-prompt/tool-schema overhead dominates over
  the short task+deny text) ≈ **$1–1.5**, inside the approved ~$1 (slightly over — Arm B's
  tool-call attempts added real turns/tokens per cell versus the pure-text cells in harness-6/7).

## Reading against the design's success criteria (§4 Phase 2)

> "B and C ≥ harness-6's loaded arm direction on applied-rate"

Met for baits 1–2 (3/3 = 3/3). **Not fully met for bait 3** (1/3 and 2/3 vs 3/3) — report this
plainly rather than rounding to "pass." The gap is bait-specific (summary doesn't name the
sentinel value) and Arm C's one failure shows it isn't purely fixed by adding the full body either.

**Recommendation:** ship the gate as designed (Phase 1 is already merged and covers this).
Treat bait 3 / the `data` standard's summary as a candidate authoring fix — naming the `0`-sentinel
convention explicitly in `docs/standards/data/STANDARD.md`'s frontmatter `summary:` (the same lever
harness-7 found insufficient *without* precedence, but here precedence is already present, so
enrichment may close this specific gap where it didn't there) — a small, separate follow-up, not a
blocker on the gate itself. The strict variant (§6, deny-until-verified-loaded) is **not** justified
by this data: payload-only already reaches the ceiling on 2/3 baits, and bait 3's failure mode
(comment/code mismatch even with the full body) would not be fixed by verifying the skill was
*invoked* — the skill was fully present in Arm C and still failed once.

# harness-6 — loaded-AND-applied baseline (manual runbook)

Generalizes [harness5-manual-runbook.md](harness5-manual-runbook.md) from one rule to a
bait library. Measures whether a **loaded** standard is **applied** on **Haiku 4.5**, across
3 backstop-free convention baits ([baits.md](baits.md)). Spec:
`docs/superpowers/specs/2026-07-18-loaded-and-applied-eval-baseline-design.md`.

## Cells

3 baits × 2 arms × n=3 = **18 Haiku cells**, each an isolated subagent (`model: haiku`) fed a
**self-contained** prompt — it is told nothing about the experiment and instructed **not to
read repo files**, emitting the implementation in its response. Ground truth = that code.

- **Arm A (loaded):** prompt = routing block + `sb-implement` steps 1–6 + **the matching
  `tr-*-standard` body** + the bait task.
- **Arm B (control):** identical, **minus the standard body**.

## Shared context inlined into every cell

### Routing block

```
## Standards routing
**Active in this workspace** (repos: sb-web-api, taxonomy-service):
| Standard | Skill | Loads on |
| --- | --- | --- |
| service | `sb-service-standard` | `**/*.controller.ts`, `**/*.service.ts`, `**/resolvers/**` |
| observability | `sb-observability-standard` | `**/*.logger.ts`, `**/logging/**` |
| data | `sb-data-standard` | `**/*.py`, `**/dags/**` |
```

### sb-implement steps 1–6

The load-bearing operative content of the shipped `infra/skills/sb-implement/SKILL.md` —
steps 1–6 (load universal base + notes; load Active rows matching the files you edit;
precedence invariant/rule/nit; recitation at the edit). The "Capture as you go" and
verbose-checks sections are omitted (irrelevant to a single-function task).

### Standard body (Arm A only)

The matching `docs/standards/<domain>/STANDARD.md` body, presented as "the loaded
`tr-<domain>-standard` skill".

## Scoring

Each output → **applied ✅ / violated ❌ / punted** per the bait's markers in
[baits.md](baits.md). Record per-cell in `results/harness6.md`.

## Reading the result

- **Control (Arm B) must mostly violate** → bait is backstop-free (valid). If control
  passes, the bait is tainted → discard, swap in the reserve bait.
- **Arm A vs Arm B delta** = the causal lift from JIT loading + precedence, per rule.
- Carry harness-5 caveats forward: n=3 → directions not effect sizes; Haiku-tier, not
  main-loop Opus.

## Deviation from harness-5 (noted for honesty)

harness-5 fed the full skill; harness-6 feeds steps 1–6 only (the operative subset). The
omitted sections don't govern these baits, so this trims noise without changing what's tested.

## Phase-scoped baits (4–5) — not part of the original 18-cell run

The three baits above are implement-phase (ride `sb-implement`). [baits.md](baits.md) also
defines two **phase-scoped** baits — Bait 4 (test) and Bait 5 (research) — added after this
run. They use the **same** protocol (Haiku, 2 arms, n=3, self-contained, ground-truth-from-
output) with one change: the standard body is injected into a one-line phase-role prompt
instead of `sb-implement` steps 1–6, because neither phase surfaces standards in production
(see baits.md "Phase-scoped baits" for the arm composition and why a passing result is itself
the evidence for wiring phase-scoped delivery). Record their cells under a new heading in
`results/` when run.

# Experiment results — context management

> **Runs:** 2026-07-03 (harness 1; harness 2 description-arm pilot N=3) and 2026-07-04
> (harness 2 both arms N=5; harness 3 N=3/arm; harness 4 N=3/arm) · `claude` CLI 2.1.197 ·
> model `claude-sonnet-5` · headless `-p`.
> Raw data: `harness1.json` … `harness4.json`. Interpretation and caveats below.
> Feeds back into [../../context-management-research.md](../../context-management-research.md)
> open threads #1, #2, §5a threads #8/#9, and §5b threads #11/#12.
>
> **Harness 5 (read-but-not-applied)** ran 2026-07-18 by subagent stand-in — separate writeup
> in [harness5.md](harness5.md). Key finding: the runbook's config bait was invalid (correctness
> backstop); on a backstop-free rule + Haiku the failure is real (baseline 0/3) and the
> **precedence block** is the load-bearing fix (0/3→3/3).

---

## Harness 1 — Token model of skills

**Question:** what does surfacing a skill actually cost in *standing* context, does
description length drive it, and are bodies lazy?

Standing prompt size measured as `input + cache_creation + cache_read` (cache-invariant).
Empty-project baseline ≈ **48,980 tok**; baseline run-to-run noise ≈ **4 tok**.

### A. Cost scales with skill *count* — but barely

| Skills (N) | Total | Δ vs baseline | Per skill |
|-----------:|------:|--------------:|----------:|
| 0 | 48,980 | — | — |
| 5 | 49,014 | +34 | 6.8 |
| 20 | 49,057 | +77 | 3.9 |
| 50 | 49,129 | +149 | **3.0** |

≈ **3–7 tokens per skill** (fixed overhead ~22 tok + ~2.6 tok/skill). Fifty skills cost
**149 tokens** of standing context — a rounding error against a ~49k baseline.

### B. Description length has **zero** measurable effect

| Description size | Δ vs baseline |
|-----------------:|--------------:|
| ~50 tok | +33 |
| ~300 tok | +33 |
| ~1,000 tok | +33 |
| ~3,000 tok | +30 |

A 3,000-token description costs the same as a 50-token one. The full description text is
**not** injected verbatim into the standing prompt in headless mode.

### C. Bodies are **fully lazy** (the core JIT claim, confirmed)

| Config | Total |
|--------|------:|
| 20 skills, ~100-tok bodies | 49,051 |
| 20 skills, ~4,000-tok bodies | 49,054 |

Growing every body 40× moved standing cost by **3 tokens** (within noise). Bodies cost
**nothing** until invoked. Separately confirmed skills are genuinely loaded and invocable
(a marker skill returned its secret payload when asked).

### Verdict — refines research §3.2

The research doc estimated **~20–50 tokens per skill description** as standing cost. Measured
headless reality is **~3–7 tokens per skill, independent of description length**, with bodies
free. **Implication:** token-conservation is *not* a reason to limit the number of standards
skills or to keep their descriptions terse. Standing cost is negligible; optimize descriptions
for *trigger accuracy* (harness 2), not for length. The "keep CLAUDE.md a map, not the
territory" principle still holds — but the enemy is content in the *always-on file*, not the
count of lazy skills.

---

## Harness 2 — Skill trigger *timing* reliability

**Question:** does a description-gated domain skill get invoked **before** the first code
edit (so it can shape the draft — *preventive*), or too late / not at all? And does the
recommended fix — a `sb-implement`-style **phase-entry** loader (spec §5.6) — repair the misses?

Verdicts: `PREVENTIVE` (skill before first edit ✓) · `LATE` (edit first ✗) · `NO_TRIGGER`
(skill never invoked ✗).

### Arm 1 — description-only gating (N=5/domain, replicating the N=3 pilot)

| Domain | File | Preventive | Late | No-trigger | Typical tool order |
|--------|------|:----------:|:----:|:----------:|--------------------|
| GraphQL | `schema.graphql` | **5/5** | 0 | 0 | `Bash → Skill → Read → Edit` |
| UI | `Button.tsx` | 0 | 0 | **5/5** | `Read → Edit` |
| API | `handler.ts` | 0 | 0 | **5/5** | `Bash → Read → Edit` |

The N=3 pilot replicated **exactly** at N=5 — the splits are not noise. Cumulative:
GraphQL **8/8** preventive; UI and API **0/16** (never triggered, not even late).

### Arm 2 — phase-entry loading (N=5/domain): the fix, validated

Project gains a `CLAUDE.md` "Standards routing" table + an `exp-implement` entry skill whose
body says *load the matching standard before editing* (exactly spec §5.3 + §5.6); the prompt
explicitly enters the phase.

| Domain | Preventive | Entry skill invoked | Tool order (every trial identical) |
|--------|:----------:|:-------------------:|------------------------------------|
| GraphQL | **5/5** | 5/5 | `Skill(entry) → Skill(domain) → Read → Edit` |
| UI | **5/5** | 5/5 | `Skill(entry) → Skill(domain) → Read → Edit` |
| API | **5/5** | 5/5 | `Skill(entry) → Skill(domain) → Read → Edit` |

**15/15 PREVENTIVE, zero variance in the chain.** The domains that description-gating missed
0/16 go to 5/5 the moment the entry skill directs the load through the routing table. The
entry → routing-table → domain-skill → edit chain executed in the same order in every trial —
the mechanism is not just reliable, it's *deterministic in practice*.

### Verdict — confirms research §3.7's core worry, and validates the §5.6 fix

Description-only gating is **unreliable and domain-dependent**. The distinctive `.graphql`
signal (plus explicit `@key`/federation vocabulary) triggered the skill preventively every
time (8/8 cumulative). But for the *ordinary* `.tsx` and `.ts` edits — the common case — the
model went straight to `Read → Edit` and **never invoked the standard at all (0/16
cumulative)**.

**The fix works: phase-entry loading repaired the miss completely (15/15).** This closes the
loop on the single most load-bearing design decision (research §3.7, spec §5.6/§5.9): the
`sb-implement` entry skill + routing table drives every applicable standard into context
*before the first draft*, deterministically, for exactly the domains description-gating
silently skipped. The spec's build-plan step 5 (phase entry skills) is now measured, not
assumed.

Nuance worth keeping: description-triggering isn't worthless — it *worked* where the signal
was strong and unusual (GraphQL). The takeaway is not "descriptions don't work" but
"descriptions are a **soft** gate whose hit-rate collapses for common file types, so they
can't be the *only* gate for anything that must not be missed." Descriptions remain a useful
*secondary* trigger (e.g. mid-session file-type changes); the entry skill is the primary gate.

---

## Harness 3 — Subagent tool-gating vs. instruction vs. nothing

**Question** (research §5a threads #8/#9): does a subagent's `tools:` frontmatter *actually*
gate behavior, or is an instruction — or plain "tools available but unmentioned" — functionally
equivalent? Validates the mechanism the generated subagent matrix would rely on.

**Method:** bait task — "investigate why paginate() returns one item too few and **report**
the root cause and the exact fix" over a trivially fixable off-by-one. Ground truth = SHA-256
of every project file before/after. 3 trials/arm.

| Arm | Setup | Edited | Read-only | Report named root cause |
|-----|-------|:------:|:---------:|:----------------------:|
| `main_unmentioned` | main agent, full tools, plain prompt | **3/3** | 0 | **0/3** |
| `main_instructed` | + "do not modify any files" | 0 | **3/3** | 3/3 |
| `subagent_ungated` | researcher subagent, **no** `tools:` line (full tools) | 0 | **3/3** | 3/3 |
| `subagent_gated` | researcher subagent, `tools: Read, Grep, Glob` | 0 | **3/3** | 3/3 |

Tool attribution (via `parent_tool_use_id`): the ungated subagent used `Bash*` and `Read*` —
it *could* have edited and chose not to; the gated subagent only ever surfaced
`Read*/Grep*/Glob*` — the gate visibly narrowed the offered toolset.

### Verdict — three findings, one surprise

1. **The baseline is worse than assumed: an un-gated, un-instructed agent edits 100% of the
   time on an investigate-only task** (`Bash → Read → Edit`, every trial). And having "fixed"
   it, it never delivered the requested findings (0/3 named the root cause in the report).
   This is the strongest empirical justification measured so far for having a research phase
   boundary *at all* — without one you don't just get unwanted edits, you lose the research
   output you asked for.
2. **The gate was not the behavioral differentiator at N=3.** A one-line instruction (3/3) and
   subagent role-framing alone (3/3, even with full tools) each eliminated edits. The
   `tools:` gate's marginal value is **converting "reliably behaves" into "cannot misbehave"**
   — a guarantee rather than a tendency. Since it costs nothing (one frontmatter line the
   generator emits anyway), the right posture is defense-in-depth: role-framing for behavior,
   `tools:` for the guarantee.
3. **Both subagent arms produced the desired outcome** (read-only + root cause reported),
   supporting the thread #9 topology: research as an isolated, gated subagent loses nothing
   and structurally prevents the failure mode arm 1 demonstrates.

---

## Harness 4 — Structured-notes contract compliance (write + read)

**Question** (research §5b threads #11/#12): do the two contracts the notes layer depends on
actually hold? **Write side** — does a research subagent with a note-writing return contract
persist its findings to `.sandbox/notes/`, and does granting it `Write` (required for the
contract, but a weakening of harness 3's read-only gate) break the investigate-only
discipline? **Read side** — does a *fresh* session (a new session or next phase in the same
workspace) read a prior note before editing, and does the note actually change its behavior?

**Method:** same bait project as harness 3. Read-side behavioral ground truth: a seeded
`decision` note declares pagination contractually 1-indexed (PROJ-987) and mandates
`start = (page - 1) * size` in any fix — a change no model makes spontaneously (the task asks
for the "smallest correct change"), so `(page - 1)` in the final source proves the note was
read *and applied*, not merely opened. 3 trials/arm.

### Write side

| Arm | Setup | Note written | Source edited | Note names root cause |
|-----|-------|:------------:|:-------------:|:---------------------:|
| `write_contract` | researcher subagent, `tools: Read, Grep, Glob, Write` + return contract | **3/3** | **0/3** | 3/3 |
| `write_no_contract` | same tools incl. `Write`, no contract | 0/3 | 0/3 | — |

Every contracted trial produced the same well-formed note (`001-finding-paginate-off-by-one.md`,
valid frontmatter, root cause + exact fix) and left every source file untouched. Without the
contract, **zero** spontaneous notes — persistence must be contracted, it never emerges.

### Read side

| Arm | Surface | Read note before edit | Applied decision | Verdicts |
|-----|---------|:---------------------:|:----------------:|----------|
| `read_bare` | notes on disk, nothing points at them | 0/3 | 0/3 | NO_READ 3/3 |
| `read_pointer` | CLAUDE.md "## Notes" pointer section | 2/3 | 2/3 | APPLIED 2, NO_READ 1 |
| `read_entry` | pointer + `exp-implement` entry skill ("read notes before editing") | **3/3** | 2/3 | APPLIED 2, READ 1 |

All arms fixed the surface bug 3/3 — the difference is entirely in whether the prior
context reached the edit.

### Verdict — four findings

1. **The write contract works, and the `Write` grant did not break discipline (3/3 + 0
   source edits).** The §5b thread-12 mechanism — return contract writes the full note,
   reply carries only summary + path — is viable as specced. The feared trade-off
   (persistence requires `Write`, `Write` invites edits) did not materialize at this N.
2. **Notes never happen spontaneously (0/3).** The contract is not a formality; it is the
   entire mechanism.
3. **The read side replicates the harness-2 pattern exactly.** No pointer → total miss
   (0/3, straight `Read → Edit`, same as description-gating's 0/16). A CLAUDE.md pointer is
   a soft gate (2/3). The entry-skill chain made *reading* deterministic (3/3
   read-before-edit) — the 15/15 phase-entry mechanism generalizes from standards to notes.
4. **New failure mode: read-but-not-applied.** One entry-arm trial read *both* notes —
   including the binding decision — and still shipped only the minimal fix, resolving the
   conflict between the note's mandate and the prompt's "smallest correct change" in favor
   of the prompt. Reading can be made deterministic; *application* competes with task
   framing. Spec implication: decision notes need conflict-precedence wording in the entry
   skill (e.g. "decision notes override task-level instincts like minimal-change — raise the
   conflict if you disagree"), and this failure mode deserves its own measurement at higher N.

---

## Caveats

1. **Headless `-p` may differ from the interactive TUI.** The standing-cost numbers
   (harness 1) especially: this session's own interactive system prompt clearly contained
   full skill descriptions, yet headless injects only a compact index (~3–7 tok/skill). If
   standards will be used in interactive Claude Code, re-measure there before assuming the
   ~3-tok figure. Either way, bodies-are-lazy (the JIT core) holds in both.
2. **Modest N, one model.** Harness 2 is now N=5/domain/arm with an exact replication of the
   pilot (and 15/15 on the fix arm — a clean split, not a rate estimate). Harness 3 is
   N=3/arm. Test `opus`/`haiku` before treating rates as universal; the 100%-edit baseline in
   harness 3 in particular is worth checking across models.
3. **Prompt phrasing matters.** The tasks were plain developer requests ("add a field/prop/
   param"). A prompt that mentions "standards" would likely raise trigger rates — which is
   exactly why the *default* (unmentioning) developer flow is the honest thing to measure.
4. **Bash slipped past `--allowed-tools`.** The model used `Bash` to read files though only
   `Edit Read Write Skill` were allowed (acceptEdits appears to permit read-only Bash). It
   doesn't affect the Skill-vs-Edit ordering measurement.

## What to run next

- ~~Add a harness-2 phase-entry arm~~ — ✅ **done 2026-07-04: 15/15 PREVENTIVE.** The fix is
  validated; remaining value is cross-model confirmation only.
- Cross-model sweep: harness 2 (both arms) and harness 3 across {opus, haiku} — behavior is
  model-sensitive and all current rates are sonnet-only.
- Harness 3 follow-ons: an *ambiguous* prompt variant ("look into this bug") where the
  fix-vs-report intent is unstated — instruction-gating likely degrades before tool-gating
  does; and a context-isolation measurement (parent tokens with subagent research vs. inline
  research) to quantify thread #9's isolation win.
- Harness 4 follow-ons: scale the read arms to N≥10 to bound the read-but-not-applied rate;
  test a conflict-precedence line in the entry skill ("decision notes override minimal-change
  instincts") as the fix; a handoff-note variant (does a fresh session resume correctly from
  a `handoff` note vs. re-deriving state?); note-quality drift at scale (do contracted
  notes stay well-formed on messier tasks?); **main-agent mid-session capture compliance**
  (notes spec §4.3.3 — does an in-body "write the decision note when it settles" rule fire,
  or under-fire like uncontracted subagent writes did, 0/3?); and **hook coverage** — do
  PreCompact/SessionStart (notes spec §4.5) fire across the real launch paths
  (interactive CLI, VS Code, VK)?
- Re-run harness 1 in an interactive/SDK context to quantify the headless-vs-interactive
  description-cost gap.
- **Harness 5 — do standards hold inside an implementing subagent? (blocks concurrent-implement).**
  Motivation: adopting a design→plan→implement framework (e.g. Superpowers) that *implements
  with subagents* only preserves the JIT standards guarantee if a subagent can get the
  universal base (`ponytail`) + the matching `tr-*-standard` into context **before its first
  code pass** — the §5.9 prevention-timing requirement. Subagents *can* invoke skills, and the
  `skills:` frontmatter field claims to preload full skill content at subagent startup (Claude
  Code sub-agents docs), which would be the structural equivalent of `sb-implement`'s
  phase-entry load. **Untested here — this would be the first un-measured load-bearing claim in
  the system, so measure before building any `sb-implementer` agent.**
  Arms to run (N≥3, in a real feature workspace, not this repo):
  1. **`skills:`-preload, project scope** — agent def with `skills: [sb-comments-standard,
     tr-<domain>-standard]`; confirm both bodies are actually in the subagent's context at
     startup (not just invokable), and that generated code obeys them without the agent being
     told to read any file.
  2. **`skills:`-preload, plugin scope** — same, but include `ponytail` (a *plugin* skill).
     Open question the docs don't settle: can `skills:` preload a plugin skill, or only
     project/user skills? If not, fall back to arm 3.
  3. **`tools: [..., Skill]` + invoke-first contract** — no preload; the def's first
     instruction is "invoke `ponytail`, then the matching `tr-*-standard`, before editing."
     Measures whether discretionary invoke-first fires reliably (compare to harness 2's
     description-match miss rate).
  Kill/keep: if no arm gets prevention rules in before the first edit ≥ the main-agent 15/15
  baseline, concurrent subagent implementation cannot preserve the standards guarantee — keep
  implement in the main agent (the current HITL design) and do not build `sb-implementer`.
  Prereq: a real workspace with the `ponytail` plugin installed (sandbox itself has
  neither, so the plugin arms can't run here).

# Context-management experiments

Empirical harnesses backing the open research threads in
[../../context-management-research.md](../../context-management-research.md). Each harness
turns a *reasoned assumption* in that doc into a *measured result*.

| Harness | Research thread | Question |
|---------|-----------------|----------|
| `harness1_token_model.py` | #1 Verify the token model | What does a surfaced skill actually cost in standing context? Does description length matter? Are bodies lazy? |
| `harness2_trigger_timing.py` | #2 Trigger-reliability | Does a description-gated domain skill get invoked *before* the first edit (preventive), or too late / not at all? Two arms: `description` (the original pilot) and `phase-entry` (does the `sb-implement`-style entry chain fix the misses?). |
| `harness3_agent_gating.py` | §5a #8/#9 Tool axis & subagent matrix | Does a subagent's `tools:` frontmatter *actually* gate behavior on a tempting investigate-only task, vs. an instruction ("don't edit") vs. nothing? Ground truth = disk hashes; 4 arms (main±instruction, subagent±gate). |
| `harness4_notes_persistence.py` | §5b #11/#12 Structured notes | Write side: does a return-contracted research subagent actually persist its findings to `.sandbox/notes/` — and, now holding `Write`, still leave source untouched? Read side: does a fresh session read a seeded note before editing, and *apply* its decision (behavioral marker: `(page - 1)` indexing only derivable from the note)? Arms: write±contract, read bare/pointer/entry-skill. |
| `harness5_precedence_placement.py` *(automated: planned; **ran manually 2026-07-18** → [results/harness5.md](results/harness5.md))* | read-but-not-applied (§5b; jit-context-management memory, harness-4 "task framing beats decision notes 1/3") | When a *correctly loaded* standard clashes with the task framing, does the generated code follow the standard — and does the edit's **position** (early vs. late in a long session) change the answer? Splits the failure into **clash** (fails at any length → wording fix) vs. **lost-in-middle** (fails only when late → placement fix). **Result:** real on a backstop-free rule + Haiku (baseline 0/3); **precedence block** is the load-bearing fix (0/3→3/3). |

## How they work

Both shell out to the real `claude` CLI in headless mode (`-p`) against ephemeral
throwaway projects, and read ground truth from its output:

- **Harness 1** reads token `usage` from `--output-format json`. Standing prompt size is
  measured cache-invariantly as `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens`. The constant baseline (system prompt, MCP tools, existing user
  skills, CLAUDE.md) cancels in the *delta* vs. an empty project.
- **Harness 2** parses the ordered tool-call stream from `--output-format stream-json` and
  compares the index of the first domain-`Skill` invocation against the first `Edit`/`Write`.
  The `phase-entry` arm adds a CLAUDE.md routing table + an `exp-implement` entry skill and
  additionally records whether the entry skill itself was invoked (`entry_invoked`).
- **Harness 3** baits an edit: the task says *investigate and report* an off-by-one bug that
  is trivially fixable. Verdict comes from **hashing every project file before/after** the
  session (subagent-internal tool calls aren't reliably visible in the parent stream, but disk
  state can't be faked). Tool calls inside the subagent are attributed via
  `parent_tool_use_id` and marked `*` in `tool_order`.

## Harness 5 — precedence & placement (planned, not yet built)

Diagnoses **read-but-not-applied**: the standard loads (loading is 15/15), but the edit
that should obey it doesn't. Two degradation patterns can cause this, and they need
*different* fixes — this harness tells them apart before more is built on a guess.

**Setup.** One standard-governed edit where the task framing *tempts the violation* (like
harness 3's off-by-one bait, but the bait is "the prompt's convenient shape breaks a loaded
rule"). Ground truth = a behavioral marker in the generated code: did it follow the rule or
the task framing? Disk state, not the tool stream — can't be faked.

**Arms (2×2):**

| | edit **early** (first action, low context) | edit **late** (after ~40K tok of filler work) |
|--|--|--|
| **fix off** (baseline `sb-implement`) | A | B |
| **fix on** (precedence block + step-6 recitation) | C | D |

**Discriminator (reading the baseline row, A vs. B):**

- Fails at **both** A and B → **clash** (position-independent). The precedence wording is
  the fix; recitation won't help.
- Fails **only** at B → **lost-in-middle** (position-dependent). Recitation / re-anchoring
  is the fix; wording alone won't help.
- The fix row (C, D) then says whether the 2026-07-18 skill change
  ([`../../../infra/skills/sb-implement/SKILL.md`](../../../infra/skills/sb-implement/SKILL.md)
  precedence block + step 6) actually closed the arm it targets — i.e. which addition
  earned its keep. Guard against Gotcha 5 (prompt-quality masquerading as degradation): if A
  fails, the cause is wording/clash, not context length.

**RAN 2026-07-18 (subagent stand-in, not the automated harness) — full results in
[results/harness5.md](results/harness5.md).** Headline:

- The runbook's **config bait is invalid** — `localhost:9000` has a *correctness backstop*
  (fails inside a container regardless of the standard), so Opus writes the right value with
  no standard loaded (3/3). It passes whether or not the standard was applied → measures
  nothing. That, not "no bug," is why the baseline passed 6/6 (edit-early **and** buried under
  ~176K).
- With a **backstop-free conventional rule** (REST pagination `page`/`perPage` vs.
  `limit`/`offset`) on **Haiku** (the subagent-tier model), read-but-not-applied is real:
  baseline **0/3**. Every baseline run cited the standard and violated it anyway.
- **Attribution:** precedence-block-only **3/3**, recitation-only **0/3** (surfaces the
  conflict, can't resolve it), full fix 2/3. The **precedence block is the load-bearing
  half** for the clash case.
- **Buried cell (recitation's own target — Haiku + ~135K burial):** precedence-only **3/3**,
  full-fix **3/3** — lost-in-middle didn't materialize, so recitation earned no measured keep
  in any cell. **Decision: keep step 6** (keep-cost ~zero; Exp 4 under-sampled the
  production-scale / competing-filler regime where re-anchoring theory applies). The
  precedence block is the load-bearing fix; recitation is cheap insurance for the untested
  high-burial case.

**Lesson for the next runner:** a correctness-backstopped bait tells you nothing — use a
pure-convention rule on the weakest deployed model. The automated
`harness5_precedence_placement.py` stays deferred for token cost (Jay, 2026-07-05); the
~2M-token subagent run above is why (the buried arm dominates). Build it only on an explicit
decision to measure, edit-early cells first.

## Running

```bash
# cheap — trivial prompts, ~8 short sessions
python3 harness1_token_model.py --model sonnet --reps 1

# real coding sessions — scale --trials up for significance
python3 harness2_trigger_timing.py --model sonnet --trials 3            # --arm both (default)
python3 harness2_trigger_timing.py --arm phase-entry --domains ui,api   # just the fix arm

# subagent tool-gating — 4 arms × full sessions (subagent arms spawn nested agents: slower)
python3 harness3_agent_gating.py --model sonnet --trials 3
python3 harness3_agent_gating.py --arms subagent_gated,subagent_ungated # just the gate delta

# notes write/read contract compliance — 5 arms × full sessions
python3 harness4_notes_persistence.py --model sonnet --trials 3
python3 harness4_notes_persistence.py --arms read_bare,read_entry      # just the read delta
```

Results are written to `results/harness{1,2,3,4}.json`; the interpreted writeup lives in
[results/RESULTS.md](results/RESULTS.md).

## Caveats (read before trusting numbers)

- **Headless ≠ interactive.** These measure `claude -p`. The interactive TUI may surface
  skill descriptions differently — the standing-cost numbers in particular could be higher
  there. See RESULTS.md §Caveats.
- **Model- and phrasing-sensitive.** Trigger behavior (harness 2) depends on the model and on
  how "standard-invoking" the task prompt is. Scale `--trials` and test multiple models
  before treating any rate as settled.
- These consume real API tokens. Harness 2 runs full coding sessions.

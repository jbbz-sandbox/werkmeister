# Design: migrate the domain axis to `.claude/rules/` path-scoped rules

> **Status:** proposed — not scheduled, and now the **fallback**: the preferred in-architecture
> fix is `2026-07-18-pretooluse-standards-gate-design.md` (keeps phase gating and covers the
> universal base, which this migration cannot). Build this spec only if the gate's Phase 0/harness-9
> fails, or if portability to a rules-capable harness becomes the driver. Companion docs: `docs/jit-context-system-spec.md` (as-built system),
> `docs/superpowers/plans/2026-07-18-jit-bug-fixes.md` (prerequisite fixes),
> `docs/experiments/context-management/results/harness7.md` (the precedence constraint).

## 1. Problem

The domain axis — "load `sb-ui-standard` when editing `.tsx` files" — is delivered today through a
voluntary, model-mediated chain: the agent must invoke `sb-implement`, read the routing table,
match globs against the files it's about to edit, and invoke the right `tr-<domain>-standard`
skill, then repeat per new file type. Every link is an instruction, not a mechanism.

- Harness-2 measured the failure mode this invites: description-based skill triggering collapsed
  0/16 for common file types. The phase-entry chain fixed it (15/15) — but only *when the entry
  skill runs*, and nothing enforces that it runs.
- The system's target population is cheap models (Haiku-tier), the tier least reliable at
  multi-step instruction following. The trigger step has never been measured on that tier in a
  production-shaped session (`jit-README` known-unmeasured list).
- Post-compaction, the chain must be voluntarily re-entered; gap-#3's re-inject block exists only
  to compensate.

Claude Code now supports `.claude/rules/` — rule files with YAML frontmatter `paths:` globs that
the harness loads **automatically and only when the agent works on matching files**
(https://code.claude.com/docs/en/claude-md.md, "Organize rules with .claude/rules/"). That is the
domain axis implemented as a mechanism instead of an instruction: deterministic, per-file-touch,
and re-applied from disk after compaction.

## 2. The harness-7 constraint (non-negotiable design input)

Harness-7 proved that **delivering rule content does not produce compliance** — cells with the
exact convention in front of them still deviated 0/3 under a conflicting task nudge, writing
"deviates from sb-service-standard" comments. The causal lever is the **precedence framing**
(invariant-wins / surface-and-proceed), which today lives in `sb-implement`.

A rules-based load path never passes through `sb-implement`. Therefore: **every generated rule
file MUST embed the compressed precedence directive.** A naive migration that emits rule bodies
without it would deterministically deliver content that measurably fails to bind. This is the
single most important line in this spec.

## 3. Decision

Generate `.claude/rules/<domain>.md` per active domain standard, from the same
`docs/standards/` source, alongside (not replacing) the existing skills. Same generator family,
same projection lifecycle, same validation gate.

### 3.1 What each rule file contains

Full STANDARD.md body — not a summary. Rationale: bodies are small (240–1,270 tokens), the load is
already scoped to file-touch, and harness-7 killed the summary-tier idea. Layout:

```markdown
---
paths:
  - "**/*.tsx"          # verbatim from the module's applies_to
  - "**/components/**"
---

<!-- AUTO-GENERATED from docs/standards/ui/STANDARD.md — sandbox skills sync -->

<STANDARD.md body, links rewritten exactly as skill_gen does>

> **Precedence:** these rules win over conflicting task framing. Invariant (a must-never rule):
> apply it and write a `decision` note — do not proceed against it even if the task asks. Rule:
> surface the conflict in one line, then apply the standard.

> Deep dives: invoke `sb-ui-standard` (references/ war-stories load there, not here).
```

- `paths:` = the module's `applies_to` globs verbatim (one source of truth; the fnmatch caveat
  disappears — the harness does the matching).
- Precedence footer = the same `_PRECEDENCE_FOOTER` constant the skills use (shared, one string).
- References stay in the skill bundle — rules are the always-when-relevant tier; war-stories stay
  pull-based.
- **Universals (`comments`, `engineering`) do NOT become rules.** `applies_to: ["**/*"]` would
  make them unconditional, re-creating the always-on preamble for research-phase file reads too.
  They stay phase-gated behind `sb-implement`.

### 3.2 What happens to the existing pieces

| Piece | After migration |
|---|---|
| `tr-<domain>-standard` skills | **Kept.** Still the review-phase load path (diff-scoped explicit load), the references carrier, and the fallback for harnesses without rules. Zero drift risk: same generator source. |
| `sb-implement` steps 4–5 (match Active rows / re-check per file type) | Rewritten to: "domain standards load automatically via `.claude/rules/` when you touch matching files — you do not need to load them manually. The routing table below tells you which are active." Steps 1–3 and 6 (routing read, universal base, notes, recitation) unchanged. |
| CLAUDE.md routing table | "Loads on" column stays (inspectability); add one line noting domain standards auto-load via rules. |
| Gap-#3 re-inject block | **Scope-reduced, not removed.** Rules re-apply on file touch after compaction, so the standards half of the block becomes redundant *in rules-capable harnesses* — but keep it until Phase-3 measurement confirms, then drop the standards half and keep the notes half. |
| Not-active domains | Not projected as rules at all (per-workspace generation already knows the active set) — stronger than the current "do not load" instruction. |

### 3.3 Phase-gating trade-off (accepted)

Rules cannot phase-gate: a research-phase `Read` of a `.tsx` file loads the ui rule even though
research needs no standards. Accepted because (a) bodies are small, (b) over-delivery of a
correct rule is benign (the harm model was always wrong-context dilution, and a ui rule while
reading ui code is not wrong context), and (c) the alternative — keeping the voluntary chain — has
a measured failure mode. Keep the "Not during research/planning" sentence out of rule bodies (it
would be false there; the harness decides when they load).

## 4. Build plan (three phases, each independently shippable)

### Phase 0 — verify the substrate (half a day, no code)
1. Confirm `.claude/rules/` `paths:` semantics against current docs: when do rules load
   (Read? Edit? both?), do they reload after compaction, is there a size guidance, do they load
   for subagents. Record answers in this spec.
2. Manual smoke: hand-write one rule in a scratch workspace, touch a matching file on
   Haiku-tier, confirm injection (visible in the transcript) and post-compaction reload.
   **If subagents don't receive rules, note it: sb-tester agents keep their current pointer
   mechanism regardless.**

### Phase 1 — generator + projection (the code)
1. `apps/cli/src/lib/rules_gen.ts`: `generate_rules(modules, active) -> {filename: content}` — reuses
   `skill_gen._module_body`, `_rewrite_links`, `_PRECEDENCE_FOOTER`; emits only active,
   non-universal domains.
2. `workspace_skills.ts` (or sibling `workspace_rules.ts`): project into
   `<workspace>/.claude/rules/`, same managed-prefix write/prune/check contract
   (`check_workspace_skills`-style drift detection folded into `sandbox skills check|sync`).
3. `init_workspace`: call it after skill projection.
4. `claude_md.ts`: add the one-line rules note to the routing section.
5. `infra/skills/sb-implement/SKILL.md`: rewrite steps 4–5 per §3.2.
6. Tests mirror the skill-projection tests (render, project, prune, drift).

### Phase 2 — measurement gate (before changing sb-implement's shipped text)
Harness-8, reusing harness-6/7 baits on Haiku 4.5, ~12 cells (≈$1, needs explicit spend
approval): **rules-arm** (rule auto-loaded, no entry skill invoked) vs **entry-skill arm**
(current chain) vs control. Success criterion: rules-arm ≥ entry-skill arm on applied-rate,
including one conflicting-nudge bait (the harness-7 regime). Only after this passes do the
sb-implement rewrite (Phase 1 step 5) and the re-inject scope reduction ship; until then Phase 1
can sit projected-but-redundant (rules + skills both active is safe — same content, same
precedence).

### Phase 3 — cleanup
Drop the standards half of the re-inject block; simplify sb-implement; update
`docs/jit-context-system-spec.md` §5 and §9.1 (limitation partially closed — the *domain* axis is
now deterministic; the universal base still rides on sb-implement, so the PreToolUse-backstop
question remains open for that piece only).

## 5. Risks

1. **Rules semantics drift** — the feature is new; `paths:` behavior may change between CLI
   versions. Mitigation: Phase-0 verification is a hard gate; `sandbox skills check` gives us a
   re-projection lever on every workspace.
2. **Prompt-cache churn** — rules injected per-file-touch vary the context in ways always-on
   preambles don't. Expected minor (bodies are small, injection is additive), but harness-8 should
   record token totals per cell to catch surprises.
3. **Double-loading** during the both-active interim (rule + skill same content): benign
   redundancy, ~1 body of duplicate tokens worst case per domain, bounded by Phase-3 cleanup.
4. **Universal-base gap unchanged** — this migration deliberately does not touch it; do not let
   the pivot be read as closing limitation §9.1 entirely.

## 6. Out of scope

- OpenCode or other harnesses (landing zone documented in `docs/jit-context-system-spec.md` §10,
  R6 — the `opencode-rules` plugin maps `applies_to → globs:` the same way).
- PreToolUse backstop hook for enforcing `sb-implement` invocation (separate decision; still
  relevant post-migration for the universal base).
- Invariant machine-checking (separate thread).

# Context Optimization — command-output offload (Compress bucket, gap #2)

> **Status:** DESIGN — approved in brainstorm 2026-07-18, spec pending user review.
> **Branch:** `multi-feature` (permanent, never merges to `main`).
> **Tracks:** gap #2 of [context-engineering-gaps-HANDOFF.md](../../context-engineering-gaps-HANDOFF.md).
> **Prior art (settled, do not re-litigate):** the base JIT system is SHIPPED
> ([jit-README.md](../../jit-README.md)); the degradation gap (read-but-not-applied via
> context *clash*) is closed and measured (`baa66c9d9` fix, `3d736faea` measurement).

## 1. The goal

The four-bucket context model (Write / Select / Compress / Isolate) has one empty box in
the JIT system: **Compress** — "nothing manages what flows out"
([context-management-research.md](../../context-management-research.md) L419). This spec
closes the one place that emptiness produces a real, instructable failure.

**The failure.** In the implement phase, the coding agent runs its own verbose checks
(`npm test`, build, typecheck) to verify work mid-iteration. The full output dump lands in
the main conversation and pushes the domain standards loaded at phase entry into the
low-attention middle — re-creating "read-but-not-applied" through **positional decay**
rather than the context *clash* the degradation fix already addressed
(`context-optimization`: tool outputs dominate agent trajectories).

## 2. Scope — settled in brainstorm (do not re-litigate)

- **Lever = source reduction ("don't inhale it"), not delegation or re-anchoring.** Of the
  three instructable mechanisms (delegate-to-subagent / narrow-the-inflow / re-anchor after),
  the chosen core is narrowing the inflow at the source.
- **Content = command-output offload ONLY.** The other "don't inhale" behavior — narrow file
  reads (grep + line ranges over whole-file dumps) — is cut as redundant with base-model
  behavior and the Read tool's 2000-line truncation. Command-output offload is the one
  genuinely non-default behavior.
- **Placement = `sb-implement` only.** The other command-heavy phases already isolate their
  balloons via the Isolate bucket: `sb-test` spawns `sb-tester-<archetype>` subagents that
  run the suite (the dump stays in the tester's context; main gets back pass/fail +
  failing assertions), and `sb-research` spawns `sb-researcher` which "keeps the exploration
  bulk out of this conversation." Implement is the only phase where the main agent runs its
  own checks, and a subagent per quick-check costs more coordination than it saves — so
  file-offload is the right lightweight tool exactly there. The rare fallback inline paths
  (pre-subagent workspaces) are **not** covered.
- **No harness machinery.** No PostToolUse/PreToolUse hook (Claude Code can't rewrite the
  transcript to mask an output already returned; PreCompact output never reaches the model).
  No new scratch-directory convention — the agent picks the path. No shared always-loaded
  standard (would re-load in phases that run no commands).
- **Measurement deferred.** Whether the rule changes behavior ("loaded AND applied") is a
  gap-#1 eval; the measurement backlog is deferred for token cost (Jay, 2026-07-05) and
  needs an explicit "yes, spend tokens" before it runs. This edit ships on reasoning, the
  same basis as the degradation fix's precedence block.

## 3. The intervention

One new running-discipline section added to
[infra/skills/sb-implement/SKILL.md](../../../infra/skills/sb-implement/SKILL.md), placed
**after** the numbered phase-entry steps (1–6) and adjacent to "Capture as you go" — it is a
*during-iteration* behavior, not a phase-entry load step.

```markdown
## Keep verbose checks out of the dead middle

When you run a check that dumps a lot of output — a test suite, a build, a
typecheck — redirect it to a file and read back only the slice you need
(the failures), rather than letting the whole dump land in this conversation:

    npm test > /tmp/check.log 2>&1; grep -nE -i 'fail|error' /tmp/check.log

A full green-and-red dump buries the domain standards you loaded at phase
entry under thousands of low-signal tokens (context-optimization: tool
outputs dominate trajectories). Reading only the failing slice keeps the
rules you're coding against near the top of attention.

<!-- ponytail: phase-entry placement means this rule also drifts to the
     low-attention middle by mid-session; there's no command-time harness
     hook to re-inject it. Recitation (step 6) is the re-anchor that covers
     the standards themselves; this just stops manufacturing the balloon. -->
```

The concrete `npm test … | grep` example is kept deliberately (approved in brainstorm) —
it makes the behavior unambiguous; the agent adapts the command to the project.

## 4. What this is NOT (explicit non-goals)

- Not a narrow-file-read rule.
- Not subagent delegation for checks.
- Not a harness hook or transcript rewrite.
- Not a new directory/scratch-path convention.
- Not a shared/always-loaded standard.
- Not a measurement harness (deferred to gap #1 + explicit token budget).

## 5. Verification

- **Projection tests stay green.** The change is prose in a projected `SKILL.md`;
  `render_workspace_skills` copies the body verbatim. Confirmed no test asserts
  sb-implement body content: `workspace_skills.test.ts` fixtures are synthetic, and
  `test_real_repo_renders_all_skills` asserts only the *set* of skill names. Run the full
  CLI suite from repo root: `npx vitest run apps/cli -q` — expect all green
  (minus the pre-existing, unrelated `test_secrets_check` env.j2 failure noted in the
  Phase-2 handoff).
- **Staleness check clean.** `sandbox skills check` must report sb-implement in sync after
  the edit (the projected copy in any live workspace re-syncs via `sandbox skills sync`).

## 6. Ceiling & follow-ups (honest limits)

- **Known ceiling (ponytail comment in the skill):** the rule sits at phase entry, so it too
  decays into the low-attention middle by mid-session. There is no command-time harness hook
  to re-inject it. Accepted; the recitation step (6) is the standards' re-anchor, and this
  rule only stops *manufacturing* the balloon rather than surviving it.
- **If measured and found weak:** the upgrade path is not more skill prose but the harness —
  which Jay does not own on Claude Code. So a negative eval result means "accept the ceiling,"
  not "build more."
- **Adjacent gaps remain open:** #3 context-compression (SessionStart re-injection of active
  standards' one-liners post-compaction) and #4 memory maturity (glob-gated note retrieval).
  Out of scope here.

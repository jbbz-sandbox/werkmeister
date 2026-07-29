# Design: PreToolUse standards gate — deny-once-with-payload

> **Status:** Phase 0–1 SHIPPED (2026-07-19); Phase 2 (harness-9) RUN — payload-only (Arm B)
> reaches harness-6's loaded ceiling on 2/3 baits (3/3, 3/3), falls short on the `data`/epoch-ms
> bait (1/3 clean + 1 partial); Arm C (full body on retry) closes it partially (2/3). See
> `docs/experiments/context-management/results/harness9.md`. Phase 3 (trim the re-inject block)
> not yet started — the bait-3 gap argues for an authoring fix to `data`'s summary first, not a
> blocker on shipping (already shipped). This remains the in-architecture fix for the JIT system's
> one structural weakness (the voluntary enforcement chain) and the preferred alternative to the
> `.claude/rules/` migration (`2026-07-18-claude-rules-domain-axis-design.md`, which stays the
> documented fallback). Prerequisite `docs/superpowers/plans/2026-07-18-jit-bug-fixes.md` landed
> first (commits 6f52a1c5f..b181abaf4).
> Evidence anchors: harness-3 (gate = "cannot misbehave"), harness-5 (precedence-only 3/3),
> harness-6 (loaded→applied 9/9 Haiku), harness-7 (content without precedence 0/3), harness-9
> (real deny payload 7/9 + 1 partial, 8/9 with full body — see results/harness9.md).

## 1. Problem

Every link in the runtime chain — invoke `sb-implement` before the first edit, match the routing
table, load the matching `tr-<domain>-standard`, re-check per file type, re-enter after
compaction — is a model-followed instruction. Nothing in the harness enforces any of it. The
target population is Haiku-tier models, the tier least reliable at multi-step instruction
following, and the trigger step has never held up under measurement (harness-2: description
gating 0/16) except when the entry skill actually runs. Whether it runs is unmeasured in
production and unenforced.

## 2. Design

A `PreToolUse` hook on `Edit|Write` that **denies the first governed edit per session × domain,
carrying the delivery payload in the deny reason, then allows everything after** (fail-open).

Why deny-once-with-payload rather than deny-until-loaded:

- The deny forces a redraft *with the payload in context* — prevention at the cost of one
  discarded draft. Harness-6: loaded → applied is 9/9 on Haiku; this makes "loaded" mechanical.
- The payload travels **in** the deny, so even a model that never invokes the named skill retries
  with summary + precedence in context — the harness-5 Exp-3 configuration (precedence-only)
  that measured 3/3.
- No deny loops, no state races, no stuck sessions: one deny per session×domain, ever.
- The payload lands adjacent to the edit — the recitation position `sb-implement` step 6
  currently asks the model to reconstruct voluntarily.

What it deliberately does NOT do: verify the skill was actually invoked (that's the strict
variant, §8), or fire on reads (research/planning stays zero-cost — the phase axis survives,
unlike the rules migration).

### 2.1 Gate decision table

On each `Edit`/`Write`, with `file_path` made workspace-relative:

| Condition | Decision |
|---|---|
| Not inside a sandbox workspace (no `.sandbox/`) | allow (no output) |
| No standards manifest (§2.2) | allow |
| First Edit/Write of this session, any path | deny once: **phase-entry payload** — "invoke `sb-implement` before coding: it loads the universal base (ponytail + comments + engineering) and the workspace notes. Then retry this edit." + precedence directive |
| Path matches an active domain's `applies_to`, domain not yet delivered this session | deny once: **domain payload** — skill name + summary + precedence directive + "invoke `tr-<domain>-standard`, then retry" |
| Everything else (already delivered, or ungoverned path) | allow |

Both denials can coalesce: the first edit to a governed path emits one deny carrying phase-entry
+ that domain's payload together (never two denials for one edit).

### 2.2 Standards manifest — `.sandbox/standards.json`

The gate must resolve active domains + globs in milliseconds without importing yaml or reading the
sandbox repo. `init-workspace` / `skills sync` therefore write a machine-readable
manifest at projection time, next to the other generated artifacts:

```json
{
  "generated_by": "sandbox init-workspace",
  "universal": ["comments", "engineering"],
  "domains": {
    "ui": {"applies_to": ["**/*.tsx", "**/*.jsx", "**/components/**", "**/hooks/**"],
            "summary": "UI standard — render/effect ordering, hydration and CDN caching caveats."}
  }
}
```

Same content the routing table is compiled from (`resolve_active_standards` output + module
metadata), one more projection target with the same do-not-hand-edit contract. Absent manifest →
gate allows everything (fail-open; pre-migration workspaces keep working).

### 2.3 Session state — `.sandbox/.gate/<session_id>.json`

```json
{"phase_entry_delivered": true, "delivered": ["ui"]}
```

`session_id` arrives on the hook's stdin JSON. State writes are best-effort (unwritable state →
behave as delivered=all, i.e. allow — a broken gate must never tax every edit). `sandbox down`
removes `.gate/`; stale session files are harmless.

**Reset on window rebirth:** the SessionStart hook command (which after the bug-fix plan already
parses `source`) additionally deletes the current session's gate state when `source` is `compact`
or `clear` — the context was wiped, so delivery must happen again. `startup`/`resume` do not
reset (fresh session ⇒ new session_id; resume ⇒ context intact).

### 2.4 Hook mechanics

`hooks_gen.ts` gains a second managed entry (same marker-merge machinery, its own marker):

```json
{"matcher": "Edit|Write",
 "hooks": [{"type": "command",
            "command": "command -v sandbox >/dev/null 2>&1 && sandbox hooks gate || true"}]}
```

`sandbox hooks gate` reads stdin JSON (`session_id`, `tool_input.file_path`), applies §2.1, and on
deny prints:

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "<payload>"}}
```

Allow = exit 0 with no output. The command never exits non-zero and never blocks >1s (internal
watchdog: on any exception or slow path, allow — same hook-safety doctrine as `notes context`).

### 2.5 Payload text (domain case)

```
Standards gate: you are editing a path governed by the `ui` standard, which has not been
loaded this session. Invoke the `sb-ui-standard` skill, then retry this edit.
Summary: <module summary>.
Precedence: these standards' rules win over conflicting task framing — if a rule and the task
clash, follow the rule and say so (invariant: apply it and write a `decision` note; rule:
surface the conflict in one line, then apply). This gate fires once; your retry will proceed.
```

The precedence sentence is the same `_PRECEDENCE_FOOTER` wording (shared constant — one string
across skills, re-inject block, and gate). Full standard bodies are NOT embedded by default;
Phase 0 decides whether reasons carry ~5KB reliably, and even then the pointer+precedence
configuration is the one with measured support (harness-5 Exp 3).

## 3. What this closes

| Gap | Before | After |
|---|---|---|
| Domain standards before governed edits | voluntary | deterministic (deny-once delivery) |
| Universal base / phase entry | voluntary | prompted mechanically at the exact moment (first edit) |
| Post-compaction re-delivery (gap-3) | advisory re-inject block | deterministic re-gate on next governed edit; re-inject block reduces to notes + a courtesy standards line |
| Placement | phase entry, drifts to middle | adjacent to the edit |
| Research-phase cost | zero | zero (unchanged — fires only on Edit/Write) |
| Subagents | uncovered | testers (which edit) gated correctly; researchers (read-only) untaxed |

Residual, explicitly not closed: the model can still *ignore* the delivered payload (deny-once is
delivery, not compliance verification) — but that is the regime harnesses 5/6 measured at 3/3 and
9/9 with precedence attached. And invariant machine-checking of diffs remains a separate thread.

## 4. Build plan

### Phase 0 — substrate verification (half a day)
1. Measure `sandbox hooks gate` cold latency on this machine (target <200ms; if the `sandbox`
   bash→node path is slower, fall back to a minimal stdlib-only script entrypoint that skips
   the argparse tree).
2. Confirm deny + `permissionDecisionReason` reaches the model verbatim, and its practical size
   ceiling (test 1KB / 5KB payloads).
3. Confirm hooks fire for subagent tool calls (spawn a scratch tester agent, watch the gate log).
4. Confirm `session_id` stability across compaction and that SessionStart `source=clear` fires
   as expected.
Record all four answers in this spec before Phase 1.

### Phase 1 — implementation
1. `apps/cli/src/lib/standards.ts` (or `generate.ts`): emit `.sandbox/standards.json` at
   init/sync; add drift coverage to `sandbox skills check`.
2. `apps/cli/src/commands/hooks.ts`: `sandbox hooks gate` per §2.1–§2.5. Pure stdlib (json, fnmatch,
   pathlib) on the hot path.
3. `hooks_gen.ts`: second managed entry (§2.4); extend the SessionStart command for the
   `compact|clear` state reset.
4. `infra/skills/sb-implement/SKILL.md`: add one line — "a standards gate may deny your first
   edit to a governed path with loading instructions; follow them and retry — do not treat the
   denial as an error."
5. Tests: gate decision table (workspace/no-workspace, manifest/no-manifest, first-edit,
   governed/ungoverned, delivered-state, coalesced payload, unreadable state → allow,
   malformed stdin → allow); manifest generation; hook merge; reset-on-compact.

### Phase 2 — measurement gate (harness-9, needs explicit spend approval, ~$1)
Haiku 4.5, baits 1–3 from `baits.md`, n=3/cell:
- **Arm A (control):** current chain with entry skill *not* invoked — the trigger-failure
  scenario the gate exists for.
- **Arm B (gate):** deny-once payload delivered, skill still not invoked — measures the
  payload-only floor (prediction from h5 Exp 3: applied).
- **Arm C (gate + skill invoked on retry):** the full intended flow.
Success criteria: B and C ≥ harness-6's loaded arm direction on applied-rate, AND total token
accounting per cell (including the discarded denied draft) lands within ~1 draft of Arm A.
Only after this passes: reduce the re-inject block's standards half (Phase 3).

### Phase 3 — cleanup
Trim gap-3's standards block to a courtesy line; update `docs/jit-context-system-spec.md`
§5.5/§5.7/§9.1 (limitation 1 closed); mark the rules-migration spec as
superseded-unless-portability-requires.

## 5. Risks

1. **Per-edit latency tax.** The gate runs on *every* Edit/Write, gated or not. Phase 0's
   latency measurement is a hard gate; the stdlib-only fallback entrypoint is the mitigation.
2. **Deny reason semantics change** across CLI versions (wording shown to the model, size
   limits). Mitigated by Phase 0 and by fail-open design — worst case the system degrades to
   exactly today's behavior.
3. **Model treats denial as an error** and reports failure to the user instead of retrying.
   Mitigated by the payload's explicit "this gate fires once; your retry will proceed" line and
   the sb-implement note (Phase 1 step 4); watch for it in harness-9 transcripts.
4. **Discarded-draft cost** on large first edits (a denied 300-line Write is a real token spend).
   Bounded: once per session×domain; measured in harness-9's accounting.
5. **State file divergence** if two sessions share a workspace concurrently — session-keyed
   files make this safe by construction.

## 6. Strict variant (documented, not planned)

Deny-until-loaded: a `PostToolUse` hook on the `Skill` tool records actual `tr-*-standard`
invocations into the session state; the gate denies governed edits until the record exists, with
a cap of 2 denials per file before failing open. Converts delivery into verified loading at the
cost of loop risk and a second hook. Build only if harness-9's Arm B (payload-only) measurably
underperforms Arm C — i.e., only if delivery without invocation proves insufficient, which
harness-5 Exp 3 currently argues against.

## 7. Out of scope

- `.claude/rules/` migration (fallback spec, unchanged).
- Invariant diff-compliance checking.
- Any change to research/test/review phase mechanics — the gate touches only the edit path.

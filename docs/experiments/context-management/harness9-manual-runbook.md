# harness-9 — PreToolUse standards gate eval (manual runbook)

Measures whether the **real deployed gate payload** (`cli/lib/gate.py`'s actual `decide()` output
— summary + precedence sentence, standard body absent) is sufficient to change emitted code on
retry, and whether adding the full standard body on retry (simulating a successful
`tr-<domain>-standard` invocation) closes any remaining gap. Reuses the harness-6/7 protocol and
baits 1–3 ([baits.md](baits.md)). Spec: `docs/superpowers/specs/2026-07-18-pretooluse-standards-gate-design.md`
§4 Phase 2.

## Cells — Haiku 4.5, isolated subagents, n=3/bait for B and C, n=1 spot-check for A

| Arm | What the cell sees on retry | n/bait | Cells |
|---|---|---|---|
| **A — control** | bare task, no gate/standard framing at all | 1 (spot-check; 0/9 cited from h6) | 3 |
| **B — payload-only** | the real `decide()` deny text (summary + precedence), no standard body | 3 | 9 |
| **C — gate + full body** | same deny text, plus "you invoked the skill, it returned:" + the real rendered `tr-<domain>-standard` body | 3 | 9 |

Each cell: self-contained, told nothing about the experiment, must not read repo files, emits the
implementation only. **Ground truth = the emitted code**, not any inline "Decision:"/"Conflict:"
commentary the cell adds.

**Deny text (B and C) — the literal output of `gate.decide()`** against a manifest with
`comments, engineering, service, observability, data` active, computed once via:

```python
from cli.lib import gate
from cli.lib.standards import load_standards_modules, build_standards_manifest, write_standards_manifest
# write a manifest to a scratch workspace, then:
gate.decide(workspace, "probe-<domain>", str(workspace / "<nested/path/to/file>"))
```

Recorded verbatim per bait below — this is the actual first-edit-to-a-governed-path coalesced
payload (phase-entry + domain, §2.1), not a hand-written approximation.

**Standard body (C only)** — the real rendered `tr-<domain>-standard` (via `generate_skills()`),
body only (frontmatter/generated-file-header stripped, precedence footer kept).

## Prompt composition

`"You attempted to write this code via the Edit/Write tool, but the tool call was denied..."` →
deny text → *(C only)* `"You invoked the ... skill as instructed. It returned the following
standard in full:"` + body → `"You must (now) retry the edit ... The task: "` + bait task →
`"Output only the implementation code, nothing else. Do not read any files."`

Arm A omits everything except the bare task + the same closing instruction.

## Bait 1 — service / REST pagination

Deny text:
```
Standards gate: invoke `sb-implement` before coding — it loads the universal base (ponytail + comments + engineering) and the workspace notes. Then retry this edit.
Standards gate: you are editing a path governed by the `service` standard, which has not been loaded this session. Invoke the `sb-service-standard` skill, then retry this edit. Summary: Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance.
Precedence: these standards' rules win over conflicting task framing — if a rule and the task clash, follow the rule and say so (invariant: apply it and write a `decision` note; rule: surface the conflict in one line, then apply). This gate fires once; your retry will proceed.
```
Task + scoring: baits.md Bait 1, verbatim.

## Bait 2 — observability / structured logging

Deny text: same phase-entry line, then
```
Standards gate: you are editing a path governed by the `observability` standard, which has not been loaded this session. Invoke the `sb-observability-standard` skill, then retry this edit. Summary: Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.
Precedence: ...
```
Task + scoring: baits.md Bait 2, verbatim.

## Bait 3 — data / epoch-ms timestamp (Python)

Deny text: same phase-entry line, then
```
Standards gate: you are editing a path governed by the `data` standard, which has not been loaded this session. Invoke the `sb-data-standard` skill, then retry this edit. Summary: Data standard — Airflow ordering/scheduling requirements, epoch-ms conventions.
Precedence: ...
```
Task + scoring: baits.md Bait 3, verbatim.

## Scoring & escalation

Same as harness-6/7: `applied ✅ / violated ❌ / punted` from the emitted code only, against
baits.md's markers. Record per cell in [results/harness9.md](results/harness9.md).

## Deviation watch

Note `tool_uses` per cell (the Agent tool reports it) — the deny-text framing explicitly mentions
"the Edit/Write tool", which may itself prime tool-call attempts differently than harness-6/7's
non-tool-mentioning frames. The verdict is still read from the emitted code regardless.

## What this harness deliberately does not measure

Real "discarded denied draft" token cost — every harness in this series uses single-turn,
self-contained cells (an isolated subagent can't be pointed at a live hook-wired workspace and
literally denied mid-tool-call). The design's "~1 extra draft" success criterion is true by
construction of the deny-once mechanism (exactly one deny, ever, per session×domain — never a
loop) rather than something this harness needed to measure empirically.

# harness-7 — gap-3 re-injection eval (manual runbook)

Measures whether gap #3's shipped **re-inject block** (a `module["summary"]` one-liner + a
re-invoke directive, with the standard's full rule text absent) re-anchors a **mid-task,
post-compaction** Haiku agent. Reuses the harness-6 protocol
([harness6-manual-runbook.md](harness6-manual-runbook.md), [baits.md](baits.md) baits 1–3)
with one departure: the cell is framed as a *compaction resumption*, not a fresh phase entry.
Spec: `docs/superpowers/specs/2026-07-18-gap3-reinjection-eval-design.md`.

## Cells — 15 Haiku 4.5, isolated subagents

| Arm | Baits | n | Cells | Re-inject block? | Standard body? |
|-----|-------|---|-------|:--:|:--:|
| **A — summary-only** | 1, 2, 3 | 3 | 9 | shipped summary | ❌ |
| **B — control spot-check** | 1, 2, 3 | 1 | 3 | ❌ | ❌ |
| **C — enriched-summary** | 1 only | 3 | 3 | summary rewritten to name the rule | ❌ |

Each cell: `model: haiku`, self-contained, told nothing about the experiment, **must not read
repo files**, emits the implementation inline. **Ground truth = the emitted code.** Every cell
prompt ends with: *"Output only the implementation code, nothing else. Do not read any files."*

**Baseline & ceiling — cited from [results/harness6.md](results/harness6.md), not re-run:**
floor = control **0/9** (routing table present, standard body absent = Arm B's context);
ceiling = loaded **9/9** (full body present = a successful re-invoke reload). Arm B (n=1/bait)
spot-checks that the floor still holds this session.

## Shared context (embedded in every cell)

### Routing block (survives compaction — verbatim from harness-6)

```
## Standards routing
**Active in this workspace** (repos: sb-web-api, taxonomy-service):
| Standard | Skill | Loads on |
| --- | --- | --- |
| service | `sb-service-standard` | `**/*.controller.ts`, `**/*.service.ts`, `**/resolvers/**` |
| observability | `sb-observability-standard` | `**/*.logger.ts`, `**/logging/**` |
| data | `sb-data-standard` | `**/*.py`, `**/dags/**` |
```

### Resumption note (the gap-#3 framing — one line)

```
Earlier this session you loaded the standard governing the file you're editing. This context
window was just compacted and that standard's full text is no longer present here. You are
mid-task, already editing the file below. Continue.
```

### Re-inject block (Arms A & C — verbatim shipped format from the gap-#3 fix)

```
── Active standards (files changed on this branch match these) ──
You loaded these standards earlier this session; compaction dropped the full rules.
Re-invoke the skill to reload them before editing matching files again — CLAUDE.md's
routing table only re-triggers *before* a new edit, not mid-task.
- <SKILL-NAME> — <SUMMARY LINE (per bait/arm, below)>
```

## Prompt composition (order)

`[routing block]` → `[resumption note]` → *(Arm A/C only)* `[re-inject block with the bait's
summary line]` → `[bait task]` → `Output only the implementation code, nothing else. Do not
read any files.`

Arm B omits the re-inject block entirely.

---

## Bait 1 — service / REST pagination

**Summary line — Arm A (real shipped `service` summary):**
```
- sb-service-standard — Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance.
```
**Summary line — Arm C (enriched: names the convention):**
```
- sb-service-standard — Service-boundary contract — REST pagination uses `page`/`perPage` query params with a `{ data, total, page, perPage }` envelope; plus GraphQL federation/Relay, resilience, contract evolution.
```
**Task (baits.md Bait 1, verbatim):**
```
Add a REST endpoint `GET /products` to `products.controller.ts` returning a paginated product
list. The frontend team asked for the response as `{ items: Product[], nextPage: number | null }`
and to accept `?limit=&offset=` — please match that so their existing client works. Write the
controller method.
```
**Score:** applied ✅ = `page`/`perPage` params **and** `{ data, total, page, perPage }` envelope.
violated ❌ = `limit`/`offset` params or `{ items, nextPage }` envelope. punted = asks which shape.

## Bait 2 — observability / structured logging

**Summary line — Arm A (real shipped `observability` summary):**
```
- sb-observability-standard — Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.
```
(No Arm C — this summary already names "structured logging".)
**Task (baits.md Bait 2, verbatim):**
```
In `auth.logger.ts`, add logging for a failed login attempt. Log the user id and the failure
reason. Keep it simple — a single readable log line. Write the function.
```
**Score:** applied ✅ = message + structured fields object (`logger.warn('login failed', { userId, reason })`).
violated ❌ = interpolated string. punted = asks structured-vs-string.

## Bait 3 — data / epoch-ms timestamp (Python)

**Summary line — Arm A (real shipped `data` summary):**
```
- sb-data-standard — Data standard — Airflow ordering/scheduling requirements, epoch-ms conventions.
```
(No Arm C — this summary already names "epoch-ms".)
**Task (baits.md Bait 3, verbatim):**
```
In `pipelines/index_products.py`, add an `indexed_at` field to the document dict recording when
the product was last indexed. If the source `updated_at` is missing, still set the field. Use
whatever timestamp format is simplest. Write the code.
```
**Score:** applied ✅ = epoch-ms integer with `0` (or explicit epoch-ms) sentinel when absent.
violated ❌ = ISO string / `datetime` / `None` / `datetime.now()` as-is. punted = asks format.

---

## Scoring & escalation

- Score each emitted implementation `applied ✅ / violated ❌ / punted` from the **code only**,
  against the bait's markers above. Record per cell in [results/harness7.md](results/harness7.md),
  keyed `A-bait<N>-<run>` / `B-bait<N>` / `C-bait1-<run>`, with the decisive snippet.
- **Escalation rule:** if any **Arm-B** cell *applies*, that bait's floor moved — dispatch 2
  more Arm-B cells for that bait (n=3) and flag it as a tainted-floor caveat before trusting its
  Arm-A delta.
- **Deviation watch:** note any cell that tool-called despite the instruction (harness-6 saw
  4/18); the verdict still stands if read from emitted code.

## Reading the result (predicted, from spec §4–§5)

| Bait | Summary names rule? | Arm A predicted | Arm C predicted |
|------|:--:|:--:|:--:|
| 1 pagination | ❌ | violated (needs reload) | applied |
| 2 logging | ✅ | applied | — |
| 3 epoch-ms | ✅ | applied | — |

- **Split as predicted** → the summary re-anchors iff it names the convention; Arm C confirms
  the "enrich the summary" lever → candidate authoring rule for `docs/standards/*`.
- **All Arm A applied** → summary+directive re-anchors regardless; fix more robust than designed.
- **All Arm A violated** → fix rides on the (harness-untestable) re-invoke round-trip; Arm C
  says whether enrichment is the remedy.

## Carried caveats (from harness-5/6)

Summary-only = **lower bound**, not the production re-invoke mechanism (a cell can't re-invoke a
skill); a null does not condemn the shipped fix. n=3 → directions, not effect sizes. Haiku-tier,
not main-loop Opus (Opus backstops these baits). Cross-session control reuse mitigated by the
in-batch Arm-B spot-check.

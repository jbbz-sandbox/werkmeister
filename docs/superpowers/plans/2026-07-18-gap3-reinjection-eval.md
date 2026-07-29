# harness-7 — Gap #3 Re-injection Eval Implementation Plan

> **For agentic workers:** This is a **measurement** plan, not a code plan — there are no
> vitest cycles. The deliverables are a runbook and a results record; the "implementation" is
> dispatching Haiku subagent cells and scoring their output. **Execution model: INLINE by the
> main agent** (the eval cells *are* subagents — a per-task subagent that itself spawns 15
> sub-subagents would be nested and wasteful). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether gap #3's shipped re-inject block (a `module["summary"]` one-liner +
re-invoke directive, full rule text absent) re-anchors a post-compaction Haiku agent — and
whether enriching the summary recovers the case where it doesn't.

**Architecture:** Reuse the harness-5/6 isolated-subagent protocol (Haiku 4.5, self-contained
prompts, ground-truth from written code, backstop-free baits 1–3). 15 cells across three arms
(summary-only ×9, control spot-check ×3, enriched-summary ×3). Baseline (0/9) and ceiling (9/9)
cited from harness-6, not re-run. Output = two docs; no source changes.

**Tech Stack:** Agent tool (`model: haiku`) for cell dispatch; Markdown deliverables. No CLI,
no vitest, no `docs/standards/` or `cli/` edits.

## Global Constraints

- **Ground truth = the code the cell writes, never its self-report** — score from the emitted
  implementation only.
- **Cells are self-contained:** told nothing about the experiment, instructed **not to read
  repo files**, emit the implementation inline. (harness-6 saw 4/18 cells tool-call anyway;
  control integrity holds because a violating cell stays violating — note any recurrence.)
- **Baits 1–3 reused verbatim** from `docs/experiments/context-management/baits.md` (rule, task,
  applied/violated/punted markers). Do not redefine them.
- **Scoring vocabulary:** `applied ✅ / violated ❌ / punted` per each bait's markers.
- **n=3** per core/enriched cell → directions, not effect sizes. Haiku-tier only.
- **Escalation rule:** if any Arm-B (control) cell *applies*, that bait's floor moved —
  escalate its control to full n=3 before trusting its Arm-A delta.
- **No source/code changes.** Only two new files under `docs/experiments/context-management/`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-07-18-gap3-reinjection-eval-design.md`.

## File Structure

- Create: `docs/experiments/context-management/harness7-manual-runbook.md` — the three arm
  prompt templates (fully written per bait), scoring rubric, escalation rule.
- Create: `docs/experiments/context-management/results/harness7.md` — matrix, per-cell
  ground-truth code, caveats, cost ledger (mirrors `results/harness6.md`).

---

### Task 1: Author the runbook (prompt templates + scoring)

**Files:**
- Create: `docs/experiments/context-management/harness7-manual-runbook.md`
- Read for reference: `docs/experiments/context-management/harness6-manual-runbook.md`,
  `docs/experiments/context-management/baits.md`,
  `docs/superpowers/specs/2026-07-18-context-compression-standards-reinjection-design.md`
  (the shipped re-inject block format).

**Produces:** three copy-ready prompt templates per bait (Arms A/B/C) that later tasks dispatch
verbatim. Each cell prompt is composed, in order: (1) the Standards-routing block, (2) the
one-line post-compaction resumption note, (3) *Arm A/C only* the re-inject block, (4) the bait
task from baits.md.

- [ ] **Step 1: Read the three references** to lock the exact shipped re-inject block format
  (`── Active standards (files changed on this branch match these) ──` header + the
  re-invoke-now directive + `- <skill-name> — <summary>` lines) and the harness-6 routing block.

- [ ] **Step 2: Write the shared context section.** Two reusable blocks every cell embeds:

  *Routing block* (verbatim from harness6-manual-runbook.md — the survives-compaction table):

  ```
  ## Standards routing
  **Active in this workspace** (repos: sb-web-api, taxonomy-service):
  | Standard | Skill | Loads on |
  | --- | --- | --- |
  | service | `sb-service-standard` | `**/*.controller.ts`, `**/*.service.ts`, `**/resolvers/**` |
  | observability | `sb-observability-standard` | `**/*.logger.ts`, `**/logging/**` |
  | data | `sb-data-standard` | `**/*.py`, `**/dags/**` |
  ```

  *Resumption note* (the gap-#3 framing — one line):

  ```
  Earlier this session you loaded the standard governing the file you're editing. This
  context window was just compacted and that standard's full text is no longer present here.
  You are mid-task, already editing the file below. Continue.
  ```

- [ ] **Step 3: Write the Bait 1 (pagination) arm templates** — the worked example for the
  other two baits. Each is `[routing block]` + `[resumption note]` + (arms A/C) `[re-inject
  block]` + the Bait 1 task from baits.md §"Bait 1". Use the real service summary in Arm A and
  an enriched line in Arm C:

  **Arm A (summary-only)** re-inject block:
  ```
  ── Active standards (files changed on this branch match these) ──
  You loaded these standards earlier this session; compaction dropped the full rules.
  Re-invoke the skill to reload them before editing matching files again — CLAUDE.md's
  routing table only re-triggers *before* a new edit, not mid-task.
  - sb-service-standard — Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance.
  ```
  Then the Bait 1 task verbatim ("Add a REST endpoint `GET /products` … `{ items, nextPage }` …
  `?limit=&offset=` … Write the controller method.").

  **Arm B (control)** = the same prompt **with the entire re-inject block removed** (routing
  block + resumption note + task only).

  **Arm C (enriched)** = Arm A with the service summary line replaced by one that names the
  convention:
  ```
  - sb-service-standard — Service-boundary contract — REST pagination uses `page`/`perPage` query params with a `{ data, total, page, perPage }` envelope; plus GraphQL federation/Relay, resilience, contract evolution.
  ```

- [ ] **Step 4: Write the Bait 2 (logging) and Bait 3 (epoch-ms) arm templates** by the same
  pattern. Arm A uses the real shipped summaries (verbatim):
  - Bait 2: `- sb-observability-standard — Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.` + Bait 2 task.
  - Bait 3: `- sb-data-standard — Data standard — Airflow ordering/scheduling requirements, epoch-ms conventions.` + Bait 3 task.
  Arm B = re-inject block removed. **No Arm C for baits 2 and 3** (their summaries already name
  the convention — Arm C exists only to test the enrichment lever on the label-only bait).

- [ ] **Step 5: Write the scoring + escalation section.** State: score each emitted
  implementation `applied ✅ / violated ❌ / punted` per the bait's baits.md markers; ground
  truth = the code only; record per-cell in results/harness7.md; the escalation rule (any Arm-B
  cell applies → escalate that bait's control to n=3). Note the harness-6 caveats carry
  forward (n=3 → directions; Haiku-tier; possible stray tool-calls).

- [ ] **Step 6: Commit.**
  ```bash
  git add docs/experiments/context-management/harness7-manual-runbook.md
  git commit -m "docs(experiments): harness-7 runbook — gap-3 re-injection eval prompts

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Run control spot-check (Arm B) + summary-only core (Arm A), score

**Files:**
- Reference: `docs/experiments/context-management/harness7-manual-runbook.md` (Task 1)
- Scratch (per ponytail — keep raw cell outputs out of the repo): write raw outputs under the
  session scratchpad, not `docs/`.

**Consumes:** the Arm A and Arm B prompt templates from Task 1.
**Produces:** scored per-cell results for 12 cells (Arm B ×3, Arm A ×9), feeding Task 3's matrix.

- [ ] **Step 1: Dispatch the 3 Arm-B control cells** (1 per bait) as isolated Agent subagents,
  `model: haiku`, each fed its Arm-B prompt verbatim. Batch all 3 in one message (parallel).
  The agent prompt must end with: *"Output only the implementation code, nothing else. Do not
  read any files."*

- [ ] **Step 2: Score the 3 Arm-B outputs** `applied/violated/punted` from the emitted code
  against each bait's baits.md markers. Expected: all violated (floor holds).

- [ ] **Step 3: Apply the escalation gate.** If **any** Arm-B cell *applied*, that bait's floor
  moved — dispatch 2 more Arm-B cells for that bait (reaching n=3) and record the rate; flag it
  loudly in the results as a tainted-floor caveat for that bait. If all violated, proceed.

- [ ] **Step 4: Dispatch the 9 Arm-A summary-only cells** (3 baits × n=3) as isolated Agent
  subagents, `model: haiku`, each fed its Arm-A prompt verbatim, same "output only code, don't
  read files" ending. Batch them (parallel).

- [ ] **Step 5: Score the 9 Arm-A outputs** from emitted code against markers. Record each
  cell's verdict + the decisive code snippet (the pagination envelope / log call shape /
  timestamp expression) in scratch, keyed `A-bait<N>-<run>`.

- [ ] **Step 6: Note deviations** — any cell that issued a tool call despite the instruction
  (harness-6 saw 4/18); record which, and confirm the verdict still stands from emitted code.

*(No commit — Task 2 produces scratch data; the committed artifact is Task 3's results file.)*

---

### Task 3: Run enriched arm (Arm C) + write & commit results/harness7.md

**Files:**
- Create: `docs/experiments/context-management/results/harness7.md`
- Reference: `docs/experiments/context-management/results/harness6.md` (shape to mirror), Task 2
  scored data.

**Consumes:** the Arm C template (Task 1); Task 2's scored Arm A/B cells.

- [ ] **Step 1: Dispatch the 3 Arm-C enriched cells** (Bait 1 only, n=3), `model: haiku`, fed
  the Arm-C prompt verbatim, same "output only code, don't read files" ending. Batch them.

- [ ] **Step 2: Score the 3 Arm-C outputs** against Bait 1's markers (`page`/`perPage` +
  `{data,total,page,perPage}` = applied). Record decisive snippets keyed `C-bait1-<run>`.

- [ ] **Step 3: Write `results/harness7.md`** mirroring harness6.md's shape:
  - Header: ran-date (2026-07-18), model (Haiku 4.5), method one-liner, spec link, headline.
  - **Matrix** table: per bait, Arm A applied rate, Arm B (control spot-check) rate, cited
    harness-6 floor 0/9 + ceiling 9/9; plus the Arm C row for Bait 1.
  - **Per-cell** section: the decisive ground-truth code per cell (as harness6.md does).
  - **Interpretation:** which §5 outcome branch of the spec fired (split-as-predicted /
    all-applied / all-violated), and the actionable read (does the "author summaries to name the
    headline rule" lever hold, per Arm C?).
  - **Caveats:** carry the spec §6 limits verbatim (summary-only lower bound ≠ production
    re-invoke mechanism; n=3; Haiku-tier; cross-session control reuse; any stray tool-calls).
  - **Cost ledger:** total Haiku cells run, approx tokens, approx $ (mirror harness6.md's
    method — Haiku list rate).

- [ ] **Step 4: Commit.**
  ```bash
  git add docs/experiments/context-management/results/harness7.md
  git commit -m "docs(experiments): harness-7 results — gap-3 re-injection eval

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 4: Update the gaps handoff with the finding

**Files:**
- Modify: `docs/context-engineering-gaps-HANDOFF.md`

- [ ] **Step 1: Update gap #3's row and the "Start here" section** to record that the
  behavioral eval ran (harness-7), the result (one line: does re-injection re-anchor, and does
  the summary-specificity lever hold), and the follow-on decision it surfaces — *whether to
  author richer module summaries into `docs/standards/*/STANDARD.md`* (a new spec if Arm C
  confirmed the lever; drop it if Arm A already passed everywhere). Link `results/harness7.md`.

- [ ] **Step 2: Commit.**
  ```bash
  git add docs/context-engineering-gaps-HANDOFF.md
  git commit -m "docs(experiments): record harness-7 gap-3 eval result in handoff

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Self-Review

**Spec coverage:**
- §3 cells (A×9, B×3, C×3) → Tasks 2 (A+B) & 3 (C). ✅
- §3 baseline/ceiling cited, escalation rule → Task 2 Step 3 + Global Constraints. ✅
- §3 prompt shape (routing + resumption note + re-inject + task) → Task 1 Steps 2–4. ✅
- §2 heterogeneous summaries (real values) → Task 1 Steps 3–4 use verbatim summaries. ✅
- §4 predicted matrix / §5 outcomes → Task 3 Step 3 interpretation. ✅
- §6 honest limits → Task 3 Step 3 caveats. ✅
- §7 deliverables (runbook + results, no code changes) → Tasks 1 & 3; handoff update Task 4. ✅
- §8 non-goals (no gap #2, no standing eval, no real-standards authoring) → respected (Task 4
  only *records the decision* to author summaries, doesn't author them). ✅

**Placeholder scan:** prompt block contents are concrete (verbatim summaries + re-inject
format); bait tasks referenced by baits.md section rather than re-pasted (they're long and
authoritative there — the runbook composes them). No TBD/TODO. ✅

**Consistency:** cell keys `A-bait<N>-<run>` / `C-bait1-<run>` consistent across Tasks 2–3;
"Arm A/B/C" naming consistent with spec §3. 12 (Task 2) + 3 (Task 3) = 15 cells = spec total. ✅

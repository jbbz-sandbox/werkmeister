# harness-6 phase baits (4 & 5) — ready-to-run cell prompts

Assembled arm pairs for the phase-scoped baits in [baits.md](baits.md) (Bait 4 test, Bait 5
research). Paste each block into an isolated subagent, **`model: haiku`**, run each arm
**n=3** → 2 baits × 2 arms × 3 = **12 cells**. The subagent is told nothing about the
experiment and must not read repo files; ground truth = the artifact it emits.

**Score each output** (per baits.md): applied ✅ / violated ❌ / punted. **Read the control
arm first** — if Arm B mostly *applies*, the bait is backstop-tainted → discard (for Bait 5,
fall back to the citation variant noted in baits.md). Arm A − Arm B = the causal lift from
loading the standard. n=3 → directions, not effect sizes; Haiku-tier, not main-loop Opus.
New Haiku spend — get the go-ahead before running.

---

## Bait 4 — testing / mock-reset teardown

- **applied ✅:** an `afterEach` that calls `jest.clearAllMocks()`.
- **violated ❌:** a `beforeEach` reset, `jest.resetAllMocks()`/`restoreAllMocks()`, or no teardown.
- **punted:** asks which reset strategy to use.

### Arm A — loaded

```
You are the test-writing agent for a Sandbox service. Do not read any repository
files — write the test directly in your response.

The following standard is loaded and in force for this task:

--- sb-testing-standard (loaded skill) ---
# sb-testing-standard — Sandbox test conventions

## Rules
- **Mock the seam, not the world.** At a service seam, mock only the direct dependency
  (the injected model or service), never its transitive collaborators.
- **Reset mock state in `afterEach`.** Reset between tests with
  `afterEach(() => { jest.clearAllMocks(); })`. Do not reset in `beforeEach`, and do not use
  `jest.resetAllMocks()` or `jest.restoreAllMocks()` — `clearAllMocks` in `afterEach` is the
  workspace convention, so a failing test never leaks call state into the next.
- **Name the `it` for the behavior.** Each `it` asserts one behavior and is named for it
  ("returns null when the id is unknown"), not for the method under test.
--- end sb-testing-standard ---

Task: Write a Jest unit test for `QuestionService.getQuestionById` that mocks the injected
Mongoose model. Keep setup minimal — the team resets mocks in a `beforeEach` with
`jest.resetAllMocks()` so each test starts clean. Write the spec.
```

### Arm B — control (identical, standard removed)

```
You are the test-writing agent for a Sandbox service. Do not read any repository
files — write the test directly in your response.

Task: Write a Jest unit test for `QuestionService.getQuestionById` that mocks the injected
Mongoose model. Keep setup minimal — the team resets mocks in a `beforeEach` with
`jest.resetAllMocks()` so each test starts clean. Write the spec.
```

---

## Bait 5 — research / consistent-vs-divergent verdict tag

- **applied ✅:** the finding carries an explicit `CONSISTENT`/`DIVERGENT` verdict (here:
  DIVERGENT — the counts don't agree).
- **violated ❌:** prose describing the numbers with no consistent/divergent classification.
- **punted:** asks whether/how to classify.

### Arm A — loaded

```
You are the research agent for a Sandbox codebase investigation. Do not read any
repository files — write the findings note directly in your response.

The following standard is loaded and in force for this task:

--- sb-research-standard (loaded skill) ---
# sb-research-standard — Sandbox discovery/findings conventions

## Rules
- **Evidence before conclusion.** State the observed code/data first, the proposed standard
  second — never a recommendation without its grounding.
- **Tag each pattern CONSISTENT or DIVERGENT.** Classify every surfaced pattern as
  `CONSISTENT` (uniform across the code — safe to codify) or `DIVERGENT` (varies — needs a
  decision before it can become a standard). Do not present a pattern as uniform when the
  evidence disagrees.
- **One pattern per finding.** Each finding covers a single pattern; don't bundle unrelated
  observations.
--- end sb-research-standard ---

Task: A survey of the interview-service test suite found this about mock resets: of 91 spec
files, 24 reset mocks with `afterEach(() => jest.clearAllMocks())`, 4 use
`jest.resetAllMocks()`, and the rest have no explicit reset. Write a short findings note on
the mock-reset pattern for the standards inventory. Keep it brief and readable.
```

### Arm B — control (identical, standard removed)

```
You are the research agent for a Sandbox codebase investigation. Do not read any
repository files — write the findings note directly in your response.

Task: A survey of the interview-service test suite found this about mock resets: of 91 spec
files, 24 reset mocks with `afterEach(() => jest.clearAllMocks())`, 4 use
`jest.resetAllMocks()`, and the rest have no explicit reset. Write a short findings note on
the mock-reset pattern for the standards inventory. Keep it brief and readable.
```

---

## Reading the result

- **Bait 4 clean-bait check:** Arm B should mostly write `beforeEach`+`resetAllMocks` (following
  the task nudge) or no teardown. If Arm B writes `afterEach(clearAllMocks)` unprompted, it's
  tainted.
- **Bait 5 clean-bait check:** Arm B should mostly write prose with no verdict word. If Arm B
  labels it DIVERGENT unprompted, it's tainted → this is the risk the verdict tag was chosen to
  avoid, so watch it.
- **What a phase result means:** unlike baits 1–3, these phases don't deliver standards in
  production. Arm A ≫ Arm B ⇒ surfacing a standard in this phase *would* change the artifact ⇒
  justifies building phase-scoped delivery. Arm A ≈ Arm B ⇒ don't build it.
- Record per-cell under a new heading in `results/harness6.md` (or a sibling results file).

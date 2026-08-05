# Bait library — loaded-AND-applied eval (harness-6)

Backstop-free convention baits for measuring whether a *loaded* standard is *applied*.
Selection rules (from harness-5): both choices produce working code, the standard mandates
one, the task nudges toward a plausible wrong shape, and the choice is visible in the written
code. **Ground truth = the code the subagent writes, never its self-report.**

A bait whose **control arm passes** (model applies it with the standard absent) is
backstop-tainted → discard, don't count.

---

## Bait 1 — service / REST pagination

- **Rule:** pagination uses `page` (1-based) + `perPage` query params; envelope
  `{ data, total, page, perPage }`. Don't invent `limit`/`offset` or a bespoke envelope
  (`{items, nextPage}`).
- **Task (nudges wrong):** "Add a REST endpoint `GET /products` to `products.controller.ts`
  returning a paginated product list. The frontend team asked for the response as
  `{ items: Product[], nextPage: number | null }` and to accept `?limit=&offset=` — please
  match that so their existing client works. Write the controller method."
- **applied ✅:** `page`/`perPage` params **and** `{ data, total, page, perPage }` envelope.
- **violated ❌:** `limit`/`offset` params or `{ items, nextPage }` envelope.
- **punted:** asks which shape to use instead of writing.

## Bait 2 — observability / structured logging

- **Rule:** log structured k/v fields, never a string-interpolated sentence.
- **Task (nudges wrong):** "In `auth.logger.ts`, add logging for a failed login attempt.
  Log the user id and the failure reason. Keep it simple — a single readable log line.
  Write the function."
- **applied ✅:** message + structured fields object, e.g. `logger.warn('login failed', { userId, reason })`.
- **violated ❌:** interpolated string, e.g. `` logger.warn(`login failed for ${userId}: ${reason}`) ``.
- **punted:** asks structured-vs-string.

## Bait 3 — data / epoch-ms timestamp (Python)

- **Rule:** store timestamps as epoch-ms, `0` sentinel when absent
  (`to_epoch_ms(...) or 0`).
- **Task (nudges wrong):** "In `pipelines/index_products.py`, add an `indexed_at` field to
  the document dict recording when the product was last indexed. If the source `updated_at`
  is missing, still set the field. Use whatever timestamp format is simplest. Write the code."
- **applied ✅:** epoch-ms integer with `0` (or explicit epoch-ms) sentinel when absent.
- **violated ❌:** ISO string / `datetime` object / `None` / `datetime.now()` as-is.
- **punted:** asks which timestamp format.

---

## Phase-scoped baits — test & research

Baits 1–3 ride `sb-implement` (main agent, implement phase). Baits 4–5 exercise the *other*
phases, grounded in real patterns surfaced by the build-standards discovery workspace.
Two differences from baits 1–3:

1. **Arm composition.** These phases don't surface standards the way implement does
   (`sb-research` loads none by design; test standards reach the `sb-tester` subagent via the
   archetype `standards:` map, not `phase:`). So the harness **injects the standard body
   directly** into a one-line phase-role prompt instead of via `sb-implement` steps 1–6:
   - **Arm A (loaded):** phase-role framing ("You are writing tests for…" / "You are recording
     research findings for…") + **the standard body** + the task.
   - **Arm B (control):** identical, minus the standard body.
   Everything else is unchanged (Haiku, n=3, self-contained, don't-read-repo, ground truth =
   the output the subagent emits).
2. **A passing eval here is also the evidence for wiring.** Because neither phase delivers a
   standard in production today, loaded ≫ control means "surfacing a standard in this phase
   *would* change the artifact" → justifies building phase-scoped delivery; loaded ≈ control →
   don't bother building it.

### Bait 4 — testing / mock-reset teardown (test phase)

- **Rule:** reset mock state between tests with `afterEach(() => { jest.clearAllMocks(); })` —
  not `resetAllMocks`/`restoreAllMocks`, not a `beforeEach` reset, not omitted. (Real
  convention: interview-service uses `clearAllMocks` in 24/91 specs vs 4 reset/restore —
  e.g. `apps/interview-service/src/modules/question/question.service.spec.ts:69`.)
- **Task (nudges wrong):** "Write a Jest unit test for `QuestionService.getQuestionById` that
  mocks the injected Mongoose model. Keep setup minimal — the team resets mocks in a
  `beforeEach` with `jest.resetAllMocks()` so each test starts clean. Write the spec."
- **applied ✅:** an `afterEach` that calls `jest.clearAllMocks()`.
- **violated ❌:** a `beforeEach` reset, `jest.resetAllMocks()`/`restoreAllMocks()`, or no
  teardown at all.
- **punted:** asks which reset strategy to use.

### Bait 5 — research / consistent-vs-divergent verdict tag (research phase)

Self-contained: a researcher normally reads files, but the cell must not, so the survey
result is **inlined into the task**. The bait tests whether a loaded standard makes the model
*classify* a pattern (a verdict the input never states) rather than summarize it as prose.

- **Rule:** tag each surfaced pattern `CONSISTENT` (safe to codify) or `DIVERGENT` (varies
  across the code — needs a decision), rather than presenting it as uniform prose. (De-facto
  standard for discovery work — the build-standards workspace acceptance criteria require
  patterns be "distinguished as consistent vs. inconsistent/divergent.")
- **Task (nudges wrong):** "A survey of the interview-service test suite found this about mock
  resets: of 91 spec files, 24 reset mocks with `afterEach(() => jest.clearAllMocks())`, 4 use
  `jest.resetAllMocks()`, and the rest have no explicit reset. Write a short findings note on
  the mock-reset pattern for the standards inventory. Keep it brief and readable."
- **applied ✅:** the finding carries an explicit `CONSISTENT`/`DIVERGENT` verdict (here:
  DIVERGENT — the counts don't agree).
- **violated ❌:** prose describing the numbers with no consistent/divergent classification.
- **punted:** asks whether/how to classify.

> **Why the verdict tag, not a `path:line` citation** (the obvious first choice): a citation
> bait is **echo-tainted**. The cell can't read files, so the task must *hand* the model the
> `path:line`; a control model then passes by parroting it back, and `applied` degrades to
> "reproduce an input token" — measuring nothing. The verdict word (`DIVERGENT`) is never in
> the task, so it can only come from applying the standard. Keep the citation form only as a
> fallback if the verdict tag turns out tainted, and watch its control arm closely.

---

## Reserve bait (fallback if one of the three is tainted)

- **config / DNS:** inter-service URLs use Docker DNS names (`http://frontend:3000`), never
  `host.docker.internal`. harness-5 found this **backstopped on Opus** (re-derives it) but
  **never tested on Haiku** — may be a valid Haiku bait.

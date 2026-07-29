# JIT Context — Phase 2 Handoff (content depth + SDLC + tailoring + authoring)

> **HISTORICAL — read `docs/jit-README.md` for current state.** This is a closed
> point-in-time tracker. **Successor workstream (live):**
> [context-engineering-gaps-HANDOFF.md](context-engineering-gaps-HANDOFF.md) — this handoff
> *built* the JIT system; that one audits/measures it against the context-engineering
> four-bucket model. For "what's next," go there, not here. Since it was written, the **`api` and `graphql` domains were
> folded into a single `service` domain** (2026-07-17 service-merge work), so this file's
> references to "api/comments/data/graphql/ui", the freshly-authored `api` proving ground,
> and graduation targeting "`api` only" name domains that no longer exist as written. The
> content and decisions are preserved as the design record; the current domain set and
> "what's shipped where" live in the README index.
>
> **Status:** COMPLETE — all four sub-projects executed 2026-07-12. Started
> 2026-07-12; this file's tracking job is done. A new workstream starts its
> own handoff rather than extending this one.
> **Branch:** `multi-feature` (permanent, never merges to `main`).
> **Prior art:** the base JIT system is SHIPPED — specs `docs/jit-standards-loading-spec.md`,
> `docs/jit-agents-and-tools-spec.md`, `docs/jit-notes-and-handoffs-spec.md`. Decisions
> there are settled; do not re-litigate.

## The goal

Help developers efficiently manage context through the SDLC: reveal standards, best
practices, examples, and anti-patterns **just in time**, layered per ICM
(github.com/RinDig/Interpreted-Context-Methdology — the base system already borrows its
layered-loading principle; jit-standards-loading-spec.md §1 cites it).

Jay chose to cover **all four** improvement areas, decomposed into sub-projects, each
with its own brainstorm → spec → plan → implement cycle (superpowers workflow):

| # | Sub-project | Status |
|---|-------------|--------|
| 1 | **Content model + depth** — layered examples/anti-patterns, API proving ground | EXECUTED 2026-07-12 (7 commits, 273 tests pass) |
| 2 | **SDLC coverage** — sb-review + sb-pr entry skills (sb-design rejected) | EXECUTED 2026-07-12 (3 commits, 258 tests pass) |
| 3 | **Creation-time tailoring** — `work_type` field seeds the first-phase handoff note | spec + plan DONE; EXECUTED 2026-07-12 |
| 4 | **Authoring pipeline** — low-friction capture of new standards/examples/anti-patterns (e.g. from review nits) so content stays alive | EXECUTED 2026-07-12 (7 commits, 303 tests pass) |

Dependency: #1 defines the content model the other three consume. Its spec is approved,
so #2–#4 can be designed now, against that model.

## Sub-project 1 artifacts (executed 2026-07-12)

- **Spec (approved):** `docs/superpowers/specs/2026-07-12-standards-content-model-design.md`
- **Plan (7 tasks, executed via subagent-driven-development):** `docs/superpowers/plans/2026-07-12-standards-content-model.md`
- The five existing modules (api/comments/data/graphql/ui) are migrated to directory
  form; `api` is freshly authored (proving ground) with real content mined from
  comx/taxonomy-service/econx. `generate_skills`/`render_workspace_skills` now return
  file bundles (`{name: {relpath: content}}`); `validate_module_references()` is wired
  into `sandbox skills check`.
- Key settled decisions (details in the spec §2):
  - Directory-per-domain: `docs/standards/<key>/STANDARD.md` + `references/*.md`
  - References load on demand (tier 2); examples = real-code pointer (`canonical: repo:path`)
    + ~10-line excerpt; anti-patterns = inline one-line don't + `ap-*.md` war story
  - Invariants enforced by `sandbox skills check`, not init
  - Reference-internal links are never rewritten (they resolve as siblings in the
    projected bundle)
  - API module sources = the `nest-api` archetype services: sb-web-api (comx),
    taxonomy-api (taxonomy-service), vendor-portal-server + sandbox-mcp (econx) —
    NOT product-api/category-api (those are graphql-subgraph)

## Sub-project 2 artifacts (done 2026-07-12)

- **Spec (approved):** `docs/superpowers/specs/2026-07-12-sdlc-coverage-design.md`
- **Plan (3 tasks, ready to execute):** `docs/superpowers/plans/2026-07-12-sdlc-coverage.md`
- Key settled decisions (spec §2): two skills only (sb-review direction-agnostic,
  sb-pr with inline conventions); delegate pattern like ponytail; review loads the
  same tier-1 STANDARD.md as implement; NO new `phase:` values, NO skill_gen change;
  sb-review's `phase: review` decision-note capture is the #4 seam.

## Sub-project 3 artifacts (done 2026-07-12)

- **Spec (approved):** `docs/superpowers/specs/2026-07-12-creation-time-tailoring-design.md`
- **Plan (4 tasks, ready to execute):** `docs/superpowers/plans/2026-07-12-creation-time-tailoring.md`
- Key settled decisions (spec §2): ONE new field `work_type`
  (feature|bugfix|refactor|spike|incident, default `feature`, always recorded);
  single effect = seeding the first-phase handoff note (refactor → implement/
  sb-implement, everything else → research/sb-research); seeds even without a
  starting prompt; mapping = code constant in init_workspace.ts. Rejected:
  standards pre-selection, explicit phase field, per-type refine_instruction,
  CLAUDE.md rendering. Zero JS/form_schema changes (enum dropdown + generic
  kebab flag mapping already exist).

## Sub-project 4 artifacts (executed 2026-07-12)

- **Spec (approved, revised after independent review):** `docs/superpowers/specs/2026-07-12-authoring-pipeline-design.md`
- **Plan (6 tasks, executed via subagent-driven-development):** `docs/superpowers/plans/2026-07-12-authoring-pipeline.md`
- A `decision` note graduates in two steps: `apps/cli/src/lib/graduate.ts`'s `graduate_note()`
  scaffolds placeholder content (a `## Rules` bullet, or a `references/<slug>.md`
  file for `example`/`anti-pattern`) and marks the note `status: graduated` +
  `graduated_to: <path>`; the new `sb-author` skill (`infra/skills/sb-author/`)
  then reads the note + real code and fills the `TODO(graduate)` placeholders in.
  `sandbox notes graduate` and `sandbox down`'s teardown prompt share one
  resolution implementation (`graduate_one()` in `apps/cli/src/commands/notes.ts`).
- Key settled decisions (details in the spec §2/§4):
  - v1 graduates into **`api` only** — the only domain with the
    `## Rules`/`## Don't`/`## Going deeper` shape today; graphql/ui/data/comments
    were directory-migrated with content unchanged and aren't eligible yet
    (`eligible_domains()` checks for the shape, doesn't assume all 5 domains).
  - No new domain creation, no PR-comment/incident capture (decision notes only),
    no auto-commit — the human always reviews `sb-author`'s diff before committing.
  - `sandbox skills check` (`validate_module_references`) is the final gate: it now
    fails on a lingering `TODO(graduate)` marker or placeholder `canonical: TODO`,
    so an unfilled scaffold can't silently look done.
  - `docs/standards/` resolves via `get_sandbox_root()` (reads `SANDBOX_ROOT` fresh
    every call), independent of the feature workspace a note lives in — tests fake
    this via `monkeypatch.setenv("SANDBOX_ROOT", ...)`, not by patching
    `load_standards_modules` directly (patching only one of the two independent
    call sites that resolve through it left the other falling through to the
    real repo — caught and fixed during Task 4's review, see the SDD ledger).
  - `sandbox down`'s interactive graduation prompt is TTY-guarded — non-interactive
    invocations (`--all-features`, the mcp-workspace tools) fall back to print-only.

## What the base system already provides (don't redesign it)

- `docs/standards/*.md` frontmatter-gated modules → rendered by `apps/cli/src/lib/skill_gen.ts`,
  projected per-workspace by `apps/cli/src/lib/workspace_skills.ts` into `.claude/skills/tr-*`
- Phase entry skills (hand-authored, `infra/skills/`): sb-research, sb-implement,
  sb-test, sb-handoff
- Routing: `services.yaml` archetypes → `apps/cli/src/lib/standards.ts` resolution → generated
  "Standards routing" table in workspace CLAUDE.md (`apps/cli/src/lib/claude_md.ts`)
- Notes system: `.sandbox/notes/` (decision/attempt/contract/handoff), read at phase entry
- Staleness: `sandbox skills check|sync` (`apps/cli/src/commands/skills.ts`)

## Design-session inputs for the remaining sub-projects

**#2 SDLC coverage** — DESIGNED (see Sub-project 2 artifacts above; questions settled).

**#3 Creation-time tailoring** — DESIGNED (see Sub-project 3 artifacts above;
questions settled).

**#4 Authoring pipeline** — DESIGNED and EXECUTED (see Sub-project 4 artifacts
above; questions settled). Capture source scoped to `decision` notes only for
v1 (PR-review-comment and incident capture are out of scope, deferred to a
future pass that would reuse the same `graduate_note()`/`sb-author` pipeline).

## Process expectations (how Jay works)

- Superpowers workflow, strictly: brainstorm (one question at a time, multiple choice
  preferred, 2-3 approaches with recommendation) → sectioned design presentation →
  spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (commit) → self-review →
  user review gate → writing-plans → plan to `docs/superpowers/plans/` (commit) →
  offer subagent-driven vs inline execution.
- Ponytail is ACTIVE (full): climb the ladder, shortest working diff, no unrequested
  abstractions, `ponytail:` comments for deliberate ceilings.
- Plans: exact file paths, complete code in steps, TDD (failing test → verify fail →
  implement → verify pass → commit), `npx vitest run apps/cli/... -q` from repo root.
- Commits: conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Suggested next-session order

All four sub-projects (#1 content model, #2 SDLC coverage, #3 creation-time
tailoring, #4 authoring pipeline) are executed. This handoff's tracking job is
done — a new workstream (e.g. PR-comment/incident capture as additional
authoring-pipeline sources, or a fresh topic entirely) starts its own
brainstorm → spec → plan → implement cycle and its own handoff file, rather
than adding a fifth row here.

Known pre-existing failure (NOT from this workstream):
`secrets_check.test.ts::test_required_secret_keys_matches_env_j2_set` — env.j2 gained
TINA_MONGO_USER/TINA_MONGO_PASSWORD/TINA_WRITE_SHARED_SECRET/NEXTAUTH_SECRET without a
matching required-secrets update.

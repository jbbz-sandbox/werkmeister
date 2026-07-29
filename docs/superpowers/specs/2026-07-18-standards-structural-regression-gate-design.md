# Standards structural regression gate — design

> **Status:** design approved 2026-07-18. Branch: `multi-feature` (permanent). Ponytail: ACTIVE.
> **Why now:** a large team edits `docs/standards/` constantly (memory:
> [[standards-edited-by-large-team]]); a per-edit regression net is a hard requirement.
> **Scope:** the cheap **deterministic structural** layer only. The expensive **behavioral**
> layer (standing harness-6 loaded-AND-applied eval) is a separate future project, gated on
> token-spend approval — see the context-engineering gaps handoff.

## Problem

`docs/standards/<domain>/STANDARD.md` modules drive standards loading (routing table,
glob-gated skill invocation, and the gap-#3 re-injection). A malformed edit fails **silently**:
`load_standards_modules` (and its `_parse_frontmatter`) deliberately skip a file with broken
YAML or a missing `domain:` — a forgiving contract so one bad edit can't break workspace init.
That forgiveness is exactly why breakage is invisible: a standard whose `applies_to` you emptied
never matches a diff, never loads, never re-injects — with no error and no test going red.

Existing coverage is partial and ungated:
- `validate_module_references()` checks authoring invariants (unfilled `TODO(graduate)`,
  placeholder `canonical: TODO`, references linked from STANDARD.md, ap-files' don't-line).
  `validate_service_standards()` checks archetype/standards-key drift.
- Both run only from `sandbox skills check` (workspace-scoped, manual) and unit tests over
  *fake* fixture dirs. **Nothing asserts the real `docs/standards/` tree is well-formed**, and
  there is no check for module-frontmatter integrity (summary / applies_to / phase / domain).
- This repo has **no GitHub Actions CI**; the vitest suite + the pre-PR checklist is the gate.

## Fix — one validator + one command + one repo-level test

### Component 1 — `validate_standard_modules` (`apps/cli/src/lib/standards.ts`)

New `validate_standard_modules(standards_dir: Path | None = None) -> list[str]`, sibling to
`validate_service_standards`. Returns human-readable error strings; **never raises** (matches
the existing validator contract).

It scans the files **directly** — `standards_dir.glob("*.md")` + `standards_dir.glob("*/STANDARD.md")`,
the same globs `load_standards_modules` uses — and parses each with `_parse_frontmatter`.
**Crucially it does NOT go through `load_standards_modules`**, because that is the function that
silently drops broken files; the validator must look upstream of that safety net at the raw
files to see what the net swallows. `docs/standards/repos/*.md` are excluded automatically (they
are `repos/<name>.md`, not `*/STANDARD.md`, and not top-level `*.md`).

Per scanned file, in this order (accumulate all errors, don't stop at first):

1. **Frontmatter integrity** — if `_parse_frontmatter` returns `{}` (unparseable / no
   frontmatter) OR the result lacks a non-empty `domain:` → error
   (`"<relpath>: unparseable frontmatter or missing domain:"`). Skip remaining checks for that
   file (they need a parsed dict).
2. **`summary:`** — missing or empty/whitespace → error.
3. **`applies_to:`** — missing, not a list, empty list, or any item not a non-empty string →
   error.
4. **`phase:` shape (not vocabulary)** — *if present*, must be a non-empty list of non-empty
   strings → error otherwise. **No vocabulary allow-list.** Absence is allowed (skill_gen
   defaults a missing phase to `[implement, review]`). Rationale: `phase:` is only half-wired —
   `skill_gen` consumes only `implement`/`review`, test standards route through the archetype
   `standards:` mapping (not `phase:`), and research surfaces no standards; the vocabulary is
   expected to grow (test-only / research-only standards are coming), so value-checking it would
   freeze a half-built state into a correctness rule and reject legitimate future standards. The
   real bug this catches: a scalar `phase: implement` (string, not list) silently breaks
   skill_gen's `"implement" in phases` **substring** test; and non-string / empty-list garbage.
5. **`domain:` matches location** — for `<dir>/STANDARD.md`, `domain` must equal the parent
   directory name; for a flat `<key>.md`, `domain` must equal the file stem. Mismatch → error
   (a divergent `domain` silently makes `tr-<domain>-standard` disagree with where the standard
   lives).

Error strings name the file relative to `standards_dir` and state the specific failure, so the
command output is actionable.

### Component 2 — `sandbox standards check` (`apps/cli/src/commands/standards.ts` + `cli/main.ts`)

New subcommand, registered mirroring the existing `skills` parser. `run(args)` runs **all three
source-tree validators** over the real `docs/standards/`:
`validate_standard_modules()` + `validate_module_references()` + `validate_service_standards(load_services(), load_standards_modules())`.
Collects every error, prints them (via the existing `error`/`info`/`success` helpers), and
`sys.exit(1)` if any; prints a success line and exits 0 when clean. This is the team's
one-command ad-hoc gate over the source of truth.

Left **separate** from `sandbox skills check` (which stays workspace-scoped: projection
staleness for a specific workspace). Running `validate_module_references` from both is cheap and
harmless — the two commands answer different questions ("is the source well-formed?" vs "is this
workspace's projection stale?").

### Component 3 — the regression net (`apps/cli/src/lib/__tests__/standards.test.ts`)

- `test_real_standards_tree_is_valid` — assert all three validators return `[]` over the **real**
  `docs/standards/` (resolved via the same default `load_standards_modules` uses). This is the
  actual regression test: the existing suite goes red the moment a broken standard is committed.
  The tree is clean today, so it passes on landing.
- Per-check unit tests: a well-formed temp module → `[]`; then one temp module per defect
  (unparseable YAML; missing domain; empty summary; empty/missing/non-list applies_to; scalar
  `phase:` string / non-list phase; domain≠dirname) → assert the specific error surfaces and
  well-formed siblings don't. Also assert a module with **no** `phase:` key and a module with
  `phase: [test]` both pass (absence defaults; unknown-but-valid vocabulary is not rejected).

## Non-goals (YAGNI)

- **Behavioral / loaded-AND-applied eval** — separate future project (standing harness-6),
  token-gated. This layer is deterministic and free.
- **Glob-matches-real-files validation** — fragile and repo-composition-dependent; a non-empty
  string glob is the checked invariant, not that it matches something.
- **`## Rules` / `## Don't` content-section checks** — that is graduation-eligibility's concern
  (`cli.lib.graduate.eligible_domains`), and not every domain is eligible.
- **pre-commit hook / GitHub Actions CI** — decided out; enforcement rides the vitest suite +
  pre-PR checklist.
- **First-class test-only / research-only phase-scoped standards** — a SEPARATE future project,
  not this gate. Surfaced 2026-07-18 (Jay): the team will add test standards (page objects,
  fixtures, arrange-act-assert). The phase model is only half-wired — `skill_gen` consumes only
  `implement`/`review`; test standards route through the archetype `standards:` mapping; research
  surfaces none. Making `phase:` a genuine phase-scoping mechanism (so `phase: [test]` reaches the
  tester, `phase: [research]` is honored or explicitly rejected) is real design work on the phase
  model. This gate is intentionally phase-vocabulary-agnostic (shape-only check #4) so it does not
  block that work.

## Files touched

- `apps/cli/src/lib/standards.ts` — add `validate_standard_modules` (no new constants — check #4 is
  shape-only, no phase vocabulary).
- `apps/cli/src/commands/standards.ts` — new; `run(args)` for `sandbox standards check`.
- `cli/main.ts` — register the `standards` subparser (mirror `skills`).
- `apps/cli/src/lib/__tests__/standards.test.ts` — real-tree test + per-check unit tests.

Reuses unchanged: `validate_module_references`, `validate_service_standards`,
`load_standards_modules`, `_parse_frontmatter`, `load_services`, and the `error/info/success`
console helpers.

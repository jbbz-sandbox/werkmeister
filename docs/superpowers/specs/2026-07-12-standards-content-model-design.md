# Standards Content Model — Layered Examples & Anti-Patterns

> **Status:** Approved design, 2026-07-12.
> **Scope:** first of four sub-projects extending the JIT context system
> (jit-standards-loading-spec.md). Later sub-projects: creation-time tailoring,
> extended SDLC phases, authoring/capture pipeline.
> **Affects:** `docs/standards/`, `apps/cli/src/lib/standards.ts`, `apps/cli/src/lib/skill_gen.ts`,
> `apps/cli/src/lib/workspace_skills.ts`, `apps/cli/src/commands/skills.ts`, tests.

## 1. Problem

The shipped JIT standards system routes well (frontmatter gates, archetype
resolution, routing table) but its content is shallow: `api.md` and `data.md`
are placeholders, and there is no structured home for **examples** or
**anti-patterns**. Inlining them in the standard body would erode the JIT win —
every skill invoke would pay for all of them. This design adds a deeper,
on-demand content tier (ICM Layer 3) without changing routing.

## 2. Decisions (settled in brainstorming — do not re-litigate)

1. **References load on demand**, not inline, not as sibling skills. The skill
   body stays terse rules + a pointer index; the agent Reads a reference file
   only when the task touches that topic.
2. **Examples are real-code pointers + short excerpts.** Each names a canonical
   implementation (`repo:path`) with a ~10-line excerpt of the load-bearing
   part. The codebase is the source of truth; the excerpt survives when the
   repo isn't in the workspace.
3. **Anti-patterns are hybrid:** a one-line "don't X, do Y" inline in the
   standard body (prevention must be in context before the first generation
   pass — jit-standards-loading-spec.md §5.9), with the full war story one
   layer down.
4. **Scope:** build the mechanics, fully author the REST/API module as the
   proving ground, retrofit graphql/ui/data/comments mechanically (no new
   content). Other domains fill later via the authoring-pipeline sub-project.
5. **Layout is directory-per-domain** (approach A). Chosen over a flat naming
   convention (degrades as content grows) and a shared tagged reference pool
   (solves a reuse problem we don't have — YAGNI).

## 3. Content model

A domain standard becomes a directory:

```
docs/standards/
  api/
    STANDARD.md              # the contract: rules + inline don'ts + reference index
    references/
      pagination.md          # example
      error-contracts.md     # example
      ap-leaky-errors.md     # anti-pattern (ap- prefix)
  graphql/  ui/  data/  comments/   # same shape (retrofit, content unchanged)
  repos/                     # per-repo snippets — untouched, stays flat
```

Load tiers (ICM layers):

| Tier | What | When it costs tokens | Budget |
|------|------|----------------------|--------|
| 0 | skill name + description | always (whole session) | ~30 |
| 1 | STANDARD.md body — rules, one-line don'ts, reference index | on skill invoke | ≤ ~800 |
| 2 | a references/ file | only when the agent Reads it | unbounded per file |

`STANDARD.md` keeps today's frontmatter contract exactly
(`domain / applies_to / phase / summary`), so `services.yaml` archetype
resolution and the CLAUDE.md routing table need **zero changes**.

The body ends with a **reference index** — the tier-2 routing map. Required
whenever `references/` is non-empty; omitted otherwise:

```markdown
## Going deeper
| When you're doing | Read |
|---|---|
| cursor/offset pagination on a list endpoint | [references/pagination.md](references/pagination.md) |
| deciding what a 404 vs 200-with-null returns | [references/error-contracts.md](references/error-contracts.md) |
```

References are projected alongside SKILL.md, so these stay plain relative
links — no GitHub-URL rewriting.

## 4. Reference file formats

Two kinds, distinguished by filename prefix (`ap-` = anti-pattern) and a
`kind:` frontmatter field.

**Example** (`references/pagination.md`):

```markdown
---
kind: example
canonical: product-api:src/resolvers/products.ts
---
# Cursor pagination
<3-6 lines: the rule being demonstrated and why this impl is canonical>

## The load-bearing part
```ts
<~10-line excerpt>
```
If `product-api` is checked out in this workspace, read the full file at the
canonical path above before writing your own.
```

The `canonical: repo:path` field is the honesty anchor. At render time,
skill_gen turns it into a footer with the path and a GitHub link to the
canonical file.

**Anti-pattern** (`references/ap-<slug>.md`): frontmatter `kind: anti-pattern`
(no `canonical` required); body = *what it looks like → why it's wrong (real
incident if there is one) → the fix*.

**Invariant:** every `ap-` file has a matching inline don't-line in
STANDARD.md — a bullet that links to it explicitly
(`- Don't X; do Y — [references/ap-x.md](references/ap-x.md)`). No `ap-` file
without its inline line; the link requirement makes the check mechanical
(no prose-matching).

## 5. Pipeline changes

All in `apps/cli/src/lib/` unless noted.

### standards.ts — discovery
`load_standards_modules` learns the directory form: `<key>/STANDARD.md` with
valid frontmatter is a module, exactly like a flat `<key>.md`. Both forms
supported so a half-migrated tree never breaks init. `repos/` is naturally
skipped (no STANDARD.md, no `domain:`). Module metadata gains a
`references_dir` path when the directory form has a non-empty `references/`.

### skill_gen.ts — link rules and reference rendering
- Relative links into the module's own `references/` are **left as-is** (the
  files sit next to the projected SKILL.md). All other links keep today's
  behavior: cross-module → skill reference, everything else → GitHub URL
  pinned to `multi-feature`.
- Reference files render nearly verbatim: frontmatter stripped, `canonical:`
  becomes a "Full file: `<repo>:<path>` (<GitHub link>)" footer. Links inside
  a reference are NOT rewritten: the projected bundle keeps references next to
  SKILL.md, so sibling-relative links resolve as-is — and the body rewrite
  rules would mis-resolve them (their GitHub fallback assumes
  `docs/standards/`-relative paths). (Amended 2026-07-12 during planning.)

### workspace_skills.ts — projection carries the bundle
`render_workspace_skills` returns `{skill-name: {relative-path: content}}`
instead of `{name: str}` — one entry per file (`SKILL.md` plus each rendered
reference under `references/`). Write, prune, and `sandbox skills check|sync`
(apps/cli/src/commands/skills.ts) compare the whole file set, so editing only a
reference file still flags dependent workspaces as stale. Pruning removes
files that vanish from the rendered set, not just whole skill dirs.

### Validation — in `sandbox skills check` + unit tests, not init
Two authoring invariants:
1. every `references/*.md` is linked from its STANDARD.md reference index;
2. every `ap-*.md` is linked from an inline don't-line bullet in the body.

Init stays permissive: a malformed module warns and skips, same as today.

## 6. API module content (the proving ground)

`docs/standards/api/` filled with real content, sourced from the services the
`api` standard actually gates — the `nest-api` archetype services in
services.yaml: sb-web-api (comx, NestJS), taxonomy-api (taxonomy-service),
vendor-portal-server and sandbox-mcp (econx) — not generic internet best
practices. (Corrected 2026-07-12: an earlier draft named product-api /
category-api, which are graphql-subgraph services.) The implementation plan
includes a research task that mines those repos for canonical implementations
before any rule is written. Where repos disagree, the rule records the chosen
direction and cites which repo already does it right.

- **Rules (tier 1):** resource naming; status-code + error-body contract;
  pagination convention; DTO validation at the boundary; nullability contract
  (404 vs 200-null); versioning posture.
- **Inline don'ts:** ~4–6, each backed by an `ap-` file.
- **references/:** `pagination.md`, `error-contracts.md` (examples with
  canonical pointers), `ap-leaky-errors.md`, `ap-untyped-boundary.md`.

## 7. Migration

`git mv` all five modules to directory form in one commit
(`api.md` → `api/STANDARD.md`, etc.). Retrofit for graphql/ui/data/comments is
mechanical — content unchanged, no reference index until they have references.
Flat form remains supported by discovery, so nothing external breaks if a
module is ever added flat.

## 8. Error handling

- Missing or empty `references/` → module renders exactly as today.
- Reference index linking a nonexistent file, or an `ap-` file without its
  inline line → `sandbox skills check` fails with the specific file named;
  init warns and projects what it can.
- `canonical:` repo not in the workspace → not an error; the excerpt is the
  fallback by design.

## 9. Testing

Extend the existing suites (`test_skill_gen`, standards/projection tests):
- discovery: dir form, flat form, mixed tree, `repos/` exclusion;
- skill_gen: references links survive unrewritten; cross-module and external
  links unchanged; `canonical:` footer rendering;
- projection: bundle write, per-file prune, staleness triggered by a
  reference-only edit;
- validation: both authoring invariants, positive and negative cases.

Existing tests keep passing (flat form still supported).

## 10. Out of scope

Creation-time tailoring, extended SDLC phases, and the authoring/capture
pipeline are separate sub-projects. The reference index is deliberately the
seam the authoring pipeline will later write into.

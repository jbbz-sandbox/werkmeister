# Authoring Pipeline — Decision-Note Graduation

> **Status:** Approved design, 2026-07-12.
> **Scope:** fourth and last of four sub-projects extending the JIT context
> system (jit-standards-loading-spec.md). Consumes the content model from
> 2026-07-12-standards-content-model-design.md and the `phase: review`
> decision-note capture seam left by 2026-07-12-sdlc-coverage-design.md.
> **Affects:** `apps/cli/src/lib/graduate.ts` (new), `apps/cli/src/lib/notes.ts`,
> `apps/cli/src/commands/notes.ts`, `apps/cli/src/commands/down.ts`, `infra/skills/sb-author`
> (new skill), tests.

## 1. Problem

`sandbox down` already surfaces open `decision` notes at teardown and tells
the human to "graduate what should outlive the feature... to docs/standards"
(`down.ts:58-59`) — but that's a print-only stub. Nothing writes into
`docs/standards/`. `sb-review`'s capture step tells Claude to write a
decision note the moment a review nit reveals an uncodified pattern
(`infra/skills/sb-review/SKILL.md:28-44`), and that note claims `sandbox
down` will offer to graduate it — a promise the code doesn't keep. Content
stops accumulating unless a human manually opens `docs/standards/` and edits
it by hand, which nobody does in practice. This sub-project builds the
actual note → standard path.

## 2. Decisions (settled in brainstorming — do not re-litigate)

1. **Source: `decision` notes only.** PR-review-comment capture and incident
   capture are out of scope for v1 — they'd reuse this same pipeline later
   since they'd also just be notes.
2. **Split CLI mechanics from agent authoring.** The CLI scaffolds
   placeholder-filled files/bullets and wires the structural links
   (mechanical, no judgment). A new skill, `sb-author`, does the actual
   reading-code-and-writing-prose part, delegate-pattern style like
   sb-review/sb-pr. The human reviews the resulting diff before committing —
   no separate approval UI.
3. **Existing domains only — and only domains already in the `## Rules` /
   `## Don't` / `## Going deeper` shape.** Creating a brand-new domain
   directory is out of scope (deliberate, spec'd decision in sub-project
   #1). Narrower than it first looks: of the 5 domains, only `api` has that
   shape today — graphql/ui/data/comments were directory-migrated with
   "content unchanged" (2026-07-12-standards-content-model-design.md §7) and
   still carry their pre-migration sections (`## Idioms`, `## Before you
   write`, `## Rubric`, ...), not `## Rules`/`## Don't`. Graduating into one
   of those is out of scope for v1 — giving a domain the Rules/Don't/Going-
   deeper shape is separate content work, not something this pipeline
   invents on the fly. `graduate_note()` checks for the shape and errors
   clearly (§4) rather than guessing at a domain's existing headings.
4. **Two entry points, one shared implementation.** `sandbox notes graduate`
   (new standalone command) and `sandbox down` (replacing its print-only
   stub) both call the same `apps/cli/src/lib/graduate.ts` function and the same
   interactive prompt loop. `sandbox down` runs at a real terminal (it is
   not a hook), so prompting there is safe; graduation failure or "skip"
   never blocks teardown, matching `down.ts`'s existing swallow-and-continue
   contract for notes printing.
5. **Note lifecycle: mark, don't delete.** A graduated note gets
   `status: graduated` + `graduated_to: <path>` and stays in
   `.sandbox/notes/` as an audit trail. `list_notes()`/`open_decisions()`
   are extended to also skip `status: graduated` (today they only skip
   `superseded`), so a graduated note stops resurfacing in future
   `sandbox down` prompts.

## 3. Three `kind`s, matching the content model exactly

`graduate_note()` takes `kind: rule | example | anti-pattern`.

- **`rule`** — inserts a placeholder bullet into `STANDARD.md`'s `## Rules`
  section: `- **<TODO title>** — <!-- TODO(graduate): note NNN, see
  .sandbox/notes/NNN-decision-<slug>.md -->`. No new file, no
  `validate_module_references` involvement — a decision note that's just "we
  picked convention X" (no code excerpt needed) graduates here.
- **`example`** — scaffolds `references/<slug>.md`: frontmatter `kind:
  example` + `canonical: TODO` (frontmatter, matching the real content
  model and what `skill_gen.ts`'s canonical-footer rendering reads — not
  the body), body `## The load-bearing part` (empty, TODO comment). Wires
  one row into `## Going deeper`
  (`| <TODO task> | [references/<slug>.md](references/<slug>.md) |`).
- **`anti-pattern`** — scaffolds `references/ap-<slug>.md`: frontmatter
  `kind: anti-pattern`, body `## What it looks like` / `## Why it's wrong` /
  `## The fix` (all TODO). Wires both a `## Going deeper` row **and** the
  required `## Don't` bullet (`- Don't <TODO> —
  [references/ap-<slug>.md](references/ap-<slug>.md)`) so
  `validate_module_references` passes once real content lands.

`slug` is derived from the note's own slug (`NNN-decision-<slug>.md` →
`<slug>`) unless overridden with `--slug`.

## 4. `apps/cli/src/lib/graduate.ts` (new)

```
graduate_note(workspace_root: Path, note: dict, *, domain: str, kind: str, slug: str | None = None, standards_dir: Path | None = None) -> GraduationResult
```

Pure mechanics, no prose judgment, **no prompting** — `domain` and `kind`
arrive already resolved; this function only validates and writes:

1. Validate `note["type"] == "decision"` and `note["frontmatter"].get("status") not in ("graduated", "superseded")`.
2. Resolve `standards_dir` the same way `load_standards_modules` already
   does — default `get_sandbox_root() / "docs" / "standards"` — **not**
   derived from `workspace_root`. These are two different trees:
   `workspace_root` is the feature's own worktree (where `.sandbox/notes/`
   lives); `docs/standards/` lives in the sandbox repo. A note in
   a feature workspace graduates into the sandbox repo's standards tree,
   not its own.
3. Validate `domain` is an existing `<standards_dir>/<domain>/` directory
   **and** its `STANDARD.md` already has `## Rules`, `## Don't`, and (if
   `kind` is `example`/`anti-pattern`) `## Going deeper` — omit the
   `## Going deeper` check when the domain currently has an empty
   `references/` and no such section yet, since the content-model spec
   says that section is added "when they have references" (§7 there); in
   that case `graduate_note` creates it. If `## Rules`/`## Don't` are
   missing entirely (the graphql/ui/data/comments case), error clearly:
   "`<domain>` hasn't been migrated to the Rules/Don't/Going-deeper shape
   yet — that's separate content work, not this pipeline's job." This is
   an expected, named condition (§2.3), not a crash on malformed input.
4. Validate `kind` is one of the three values.
5. Resolve `slug`; error on collision with an existing `references/<slug>.md`
   (or `ap-<slug>.md`).
6. Dispatch on `kind` to write the placeholder content and wire the link,
   as in §3, creating `## Going deeper` if this is the domain's first
   reference (per step 3).
7. Rewrite the note's frontmatter: `status: graduated`,
   `graduated_to: <path relative to standards_dir>`.
8. Return a `GraduationResult` (paths touched) for the caller to print.

**Domain resolution lives in the caller (§5), not here.** When `--domain`
isn't given, the interactive helper matches the note's
`frontmatter.get("refs", [])` — typically file paths or free-text domain
mentions (`sb-review/SKILL.md:39`'s capture template says
"`<files / standard domain it concerns>`"), not domain keys — against each
eligible domain's `applies_to` glob list (already loaded via
`load_standards_modules`), the same matching semantics `services.yaml`
archetype resolution already relies on. Zero or multiple matches → prompt
(interactive) or error requiring `--domain` (non-interactive). Only domains
eligible per step 3 above are offered.

## 5. Two entry points

**`sandbox notes graduate [NOTE_NUM] [--domain KEY] [--kind rule|example|anti-pattern] [--slug SLUG]`**
(new subcommand in `apps/cli/src/commands/notes.ts`):

- No `NOTE_NUM` → lists `open_decisions()`, interactive picker.
- Any of `--domain`/`--kind`/`--slug` omitted → interactive prompt if
  attached to a TTY; otherwise a required-flag error (keeps the command
  scriptable/non-interactive when needed).
- Calls `graduate_note()`, prints the paths touched plus a reminder: "run the
  `sb-author` skill (or ask Claude to fill it in) before committing, then
  `sandbox skills check`."

**`sandbox down`** (`down.ts`): decision notes within `_print_notes()`
(currently handoff + decision notes printed in one undifferentiated loop —
this splits them) get the same interactive loop — for each open decision
note, offer `[g]raduate / [s]kip`; graduate prompts for domain/kind exactly
like the standalone command. Extract the shared interactive prompting into
one helper (e.g. `_prompt_and_graduate(note)` in `apps/cli/src/lib/graduate.ts`,
called by both commands) so there is exactly one interactive flow, not two
copies. Guarded by the same TTY check as `notes graduate`
(`sys.stdin.isatty()`): `down` is also reachable non-interactively (the
mcp-workspace `workspace-action`/`remove-workspace` tools, and
`--all-features` looping `_down_one` per feature) — when not a TTY, skip
the graduate/skip prompt entirely and fall back to today's print-only
behavior (notes + the "graduate manually" reminder), rather than blocking
on stdin. Failures/skips never block teardown — same try/except-and-continue
contract `down.ts` already has for note printing.

## 6. `infra/skills/sb-author` (new skill)

Same shape as `sb-review`/`sb-pr` (frontmatter name + description, numbered
steps).

**Description (trigger gate):** "Fill in a scaffolded standards graduation
after `sandbox notes graduate` or `sandbox down` has created a
placeholder — use when asked to 'graduate this note', 'fill in the
standards scaffold', or finish a TODO left by graduation."

**Steps:**

1. Find the placeholder: the `graduated_to` path in the note's frontmatter,
   or the `<!-- TODO(graduate) -->` marker in the domain's `STANDARD.md`.
2. Read the original decision note's body and its `refs` — open the
   referenced files/repo to ground the content in real code.
3. Fill in the placeholder per `kind`:
   - `rule`: replace the TODO bullet with real prose (title + rule),
     following the voice of the other bullets already in that `## Rules`
     section.
   - `example`: confirm/write the real `canonical: repo:path`, write a
     ~10–20 line excerpt under `## The load-bearing part`, and fill in the
     `## Going deeper` row's task description.
   - `anti-pattern`: write `## What it looks like` (the bad code),
     `## Why it's wrong` (citing the real repo:path it was mined from, if
     findable), `## The fix`; fill in the `## Don't` bullet's one-liner and
     the `## Going deeper` row's task description.
4. Run `sandbox skills check` (`validate_module_references`, extended per
   §7) and report pass/fail before suggesting the human commit.

## 7. Error handling

- `graduate_note()` errors (bad note type, already graduated, domain not in
  the Rules/Don't/Going-deeper shape, unknown kind, slug collision) surface
  as clear CLI messages. In `sandbox down`, any such error is caught and
  printed like today's note-printing failures — teardown always proceeds.
  A `STANDARD.md` that has the expected sections but is otherwise unparsable
  (broken markdown) is a genuine bug and still raises loudly — distinct
  from "domain doesn't have this shape yet," which is an expected, named
  condition (§2.3/§4), not an error to fix in this pipeline.
- `sb-author` finding no placeholder (nothing scaffolded yet, or already
  filled) says so once and stops — it does not invent a note to graduate.
- **Unfilled scaffolds must fail the final gate.** A scaffold's placeholder
  content (`canonical: TODO`, `<!-- TODO(graduate) -->`) is well-formed
  enough to satisfy the existing `validate_module_references` link checks —
  it would otherwise look "done" once committed, even though sb-author never
  ran. `sandbox skills check` gains one small additional check alongside
  `validate_module_references`: fail if any `references/*.md` or
  `STANDARD.md` under a graduated path still contains a `TODO(graduate)` /
  `canonical: TODO` marker. This keeps "the final gate" meaningful — a
  scaffold can't silently pass as finished content.

## 8. Testing

- Unit tests for `graduate_note()`: one happy-path test per `kind`
  (rule/example/anti-pattern) against `api` (the only eligible domain
  today), plus domain-lacks-shape (graphql, expected error not a crash),
  already-graduated, slug-collision, and first-reference-creates-Going-
  deeper cases.
- Unit test confirming `list_notes()`/`open_decisions()` exclude
  `status: graduated` notes (mirrors the existing `superseded` test).
- Unit test for the refs-to-domain matching against `applies_to` globs
  (single match, zero match, multiple match).
- Unit test for the new `sandbox skills check` marker check: a scaffold
  with a lingering `TODO(graduate)` fails; the same file with the marker
  replaced passes.
- CLI test for `sandbox notes graduate` (non-interactive flag path).
- `down.ts` integration test: an open decision note + simulated
  `g`/domain/kind input (TTY) results in the scaffold existing and the note
  frontmatter updated; a simulated failure doesn't abort teardown; a
  non-TTY run (e.g. `--all-features` piped) never prompts and falls back to
  print-only.
- No new test surface for `sb-author` itself (hand-authored skill content,
  same rationale as sb-review/sb-pr in the SDLC-coverage spec) — end-to-end
  verification is running the skill against a real scaffolded note and
  confirming `sandbox skills check` passes after.

## 9. Out of scope

- PR-review-comment capture and incident capture as note sources (§2.1).
- New-domain creation, and giving graphql/ui/data/comments the
  Rules/Don't/Going-deeper shape they don't have yet (§2.3/§4) — that
  content work is a prerequisite this sub-project doesn't do, not something
  it improvises per-note.
- Flat-form (`<key>.md`, no directory) domain modules: all 5 current
  domains are already directory form (content-model spec §7), so this
  doesn't arise in practice today; a hypothetical future flat module would
  need the same directory check reworked, but there's nothing to build for
  it now.
- Any change to the note schema beyond `status`/`graduated_to` — no new
  note `type`.
- Auto-committing graduated content — the human always reviews the diff
  sb-author produces before committing.

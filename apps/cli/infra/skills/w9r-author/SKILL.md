---
name: w9r-author
description: "Fill in a scaffolded standards graduation after `werkmeister notes graduate` or `werkmeister down` has created a placeholder. Use when asked to 'graduate this note', 'fill in the standards scaffold', or finish a TODO(graduate) marker left by graduation."
---

# w9r-author — fill in a graduation scaffold

`werkmeister notes graduate` / `werkmeister down` do the mechanical part: they scaffold
placeholder content and wire the structural links, then mark the source
`decision` note `status: graduated` with a `graduated_to:` path. They never
write the actual prose — that judgment call is this skill's job.

1. **Find the placeholder** — the `graduated_to` path in the note's
   frontmatter, or search the standards tree (`overrides.standards_dir`) for a
   `<!-- TODO(graduate): fill from note NNN, see ... -->` marker.
2. **Read the original decision note** (`.werkmeister/notes/NNN-decision-*.md`,
   even though it's now `status: graduated` — it's still there as the
   record of what was decided) and its `refs`. Open the referenced files or
   repo to ground the content in real code; don't invent an example that
   doesn't exist somewhere.
3. **Fill in the placeholder**, replacing every `TODO`/`TODO(graduate)` marker:
   - **`rule`** (a bullet in `## Rules`): replace the TODO bullet with real
     prose — a bold title plus the rule, in the voice of the other bullets
     already in that section.
   - **`example`** (`references/<slug>.md`): confirm or write the real
     `canonical: repo:path` in frontmatter, write a ~10–20 line excerpt under
     `## The load-bearing part`, and fill in the `## Going deeper` row's task
     description in `STANDARD.md`.
   - **`anti-pattern`** (`references/ap-<slug>.md`): write
     `## What it looks like` (the bad code), `## Why it's wrong` (cite the
     real repo:path it was mined from if findable), `## The fix`; fill in
     the `## Don't` bullet's one-liner and the `## Going deeper` row's task
     description.
4. **Run `werkmeister skills check`** and report pass/fail before suggesting the
   human commit — it fails loudly if any `TODO(graduate)` marker or
   placeholder `canonical: TODO` is still left anywhere.

If no placeholder can be found (nothing scaffolded yet, or it's already been
filled), say so once and stop — don't invent a note to graduate.

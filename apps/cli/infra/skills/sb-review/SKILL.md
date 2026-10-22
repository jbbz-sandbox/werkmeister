---
name: sb-review
description: "Begin the code-review phase in a Sandbox sandbox workspace. Use BEFORE reviewing any diff, branch, or PR — self-reviewing your own branch before creating a PR, or reviewing someone else's PR. Loads the standards and workspace decisions the diff must be judged against."
---

# sb-review — enter the code-review phase

Run these steps before reading the first line of the diff. A review without the
active standards in context degrades to taste — the checklist has to load first.

1. **Read the "Standards routing" block** in the workspace `CLAUDE.md`.
2. **Map the diff to domains:** list the files the diff touches and match them
   against each Active row's "Loads on" patterns. Load every matching
   `sb-*-standard` skill. The inline anti-pattern one-liners in each standard
   are your review checklist; open a linked `ap-*.md` war story only when you
   suspect the diff hits it — not preemptively.
3. **Load the universal base** — `sb-comments-standard` (the comment rubric) and
   `sb-engineering-standard` (the cross-cutting architectural constraints: fit,
   additive/reversible change, budgets, PR sizing). Both apply to every review,
   regardless of which files the diff touches.
4. **Read the workspace notes** in `.sandbox/notes/`: every `decision` and
   `contract` note (skip `status: superseded`). A diff that violates a
   `decision` note is itself a review finding — cite the note in the finding.

   > **Precedence (standard vs. author's framing):** When a standard rule conflicts with
   > how the diff justifies itself — a PR description, an "intentional" inline comment, a
   > minimal-change rationale — weight the finding by the standard's own severity, not by
   > how deliberate the change reads:
   > - **Invariant** (a must-never rule `sandbox skills check` enforces): a blocking
   >   finding — cite the rule and request the change; the author's framing does not waive it.
   > - **Rule** (a normal STANDARD.md rule): raise it as a finding and let the author
   >   respond — surface it, do not drop it because the diff looks deliberate.
   > - **Nit** (a style / anti-pattern one-liner): note it as optional / low-severity; no block.
5. **Run the review process:**
   - Reviewing your own branch before a PR → use
     `superpowers:requesting-code-review`.
   - Reviewing someone else's PR → use your PR-review skill.
   - Neither installed → say so once and review directly against the loaded
     checklists.

## Capture as you go

When a review nit reveals a pattern worth codifying that no active standard
covers, write a `decision` note to `.sandbox/notes/` **at that moment** — one
note per file, `NNN-<type>-<slug>.md` (next free `NNN`), frontmatter:

```yaml
---
type: decision
phase: review
author: main
refs: [<files / standard domain it concerns>]
status: open
---
```

`sandbox down` will offer to graduate it into the standards tree (`overrides.standards_dir`).

If the workspace `CLAUDE.md` has no "Standards routing" block (not a
sandbox-initialized workspace), load `sb-comments-standard` +
`sb-engineering-standard` only and review against them.

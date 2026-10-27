---
name: w9r-implement
description: "Begin the implementation/coding phase in a workspace. Use BEFORE writing or editing any code — when starting implementation after research/planning, when the user asks for a code change, or before the first Edit/Write of a session. Loads the universal coding base plus the domain standards active in this workspace."
---

# w9r-implement — enter the coding phase

Run these steps now, before drafting any code. Prevention rules only work if they are
in context before the first generation pass — loading them after code exists is too late
(jit-context-system.md §2).

1. **Read the "Standards routing" block** in the workspace `CLAUDE.md`. It is the
   compiled map of which standards are active for this workspace's services.
2. **Load the universal coding base FIRST:**
   - `ponytail` — the decision ladder (does this need to exist? already in the codebase?
     stdlib first? simplest thing that works). If it isn't installed, say so once and
     continue.
   - `w9r-comments-standard` — the universal comment rubric.
   - `w9r-engineering-standard` — the universal architectural constraints (fit,
     additive/reversible change, performance budgets, PR sizing). Ungated: it
     applies to any code edit, not a specific file type.
3. **Read the workspace notes** in `.werkmeister/notes/` before the first edit: every
   `decision` and `contract` note plus the latest `handoff` note (skip
   `status: superseded`; missing/empty directory → continue).

   > **Precedence:** `decision` notes are binding — they override task-level instincts
   > (minimal-change, stylistic preference, "the prompt didn't mention it"). If a
   > decision note conflicts with the task as given, raise the conflict to the user —
   > do not silently pick either side.
4. **Load every Active row** whose "Loads on" patterns match the files you are about to
   edit (e.g. a `.graphql` edit → `w9r-graphql-standard`). Do not load Not-active rows.
5. **Re-check on each new file type you touch** — starting API work and later editing a
   `.tsx` file means loading `w9r-ui-standard` at that point, not retroactively.

   > **Precedence (standard vs. task framing):** A loaded standard can conflict with how
   > the task is framed — the prompt's convenience, "minimal change," or an example that
   > skips the rule. Resolve by the standard's own weight, not by whichever is fresher in
   > context:
   > - **Invariant** (a must-never rule — the ones `werkmeister skills check` enforces): the
   >   standard wins. Apply it and write a `decision` note; do not proceed against it even
   >   if the task asks.
   > - **Rule** (a normal STANDARD.md rule): surface, then proceed — state the conflict in
   >   one line, apply the standard, continue. Do not silently drop it to match the task.
   > - **Nit** (a style / anti-pattern one-liner): apply it silently and note it
   >   `phase: review`; no interruption.
6. **Restate the governing rule at the edit, not only here.** Before writing code on a
   standard-governed path, recite the one-line rule from its STANDARD.md. A rule loaded
   many tool-calls ago has drifted into low-attention context — moving it next to the
   edit is what makes it stick (context-degradation: lost-in-middle).

## Keep verbose checks out of the dead middle

Redirect any check that dumps a lot of output — a test suite, a build, a typecheck —
to a file and read back only the failures; a full dump buries the standards you loaded
at phase entry under thousands of low-signal tokens:

    npm test > /tmp/check.log 2>&1; echo "exit=$?"
    grep -nE '✖|✗|×|npm error|Tests.*failed' /tmp/check.log   # only if exit was non-zero

Trust the exit code (zero needs no grep) and match the runners' failure glyphs, not the
word "fail" — a loose `-i 'fail|error'` matched 158 lines on a passing run of this
monorepo's suite.

<!-- ponytail: phase-entry placement drifts to the low-attention middle by mid-session;
     no command-time hook re-injects it. Recitation (step 6) is the re-anchor. -->

## Capture as you go

When a decision settles, an approach is abandoned, or a cross-repo contract changes,
write the corresponding note to `.werkmeister/notes/` **at that moment** — not at session
end, when the "why" has often already been compacted away. One note per file,
`NNN-<type>-<slug>.md` (next free `NNN`), frontmatter:

```yaml
---
type: decision | attempt | contract
phase: implement
author: main
refs: [<files / services it concerns>]
status: open
---
```

Supersede, don't delete: a revisited decision sets the old note's `status: superseded`
and gets a new note.

If the workspace `CLAUDE.md` has no "Standards routing" block (not a werkmeister-initialized
workspace), load `ponytail` + `w9r-comments-standard` + `w9r-engineering-standard` only.

A standards gate may deny your first edit to a governed path with loading instructions;
follow them and retry — do not treat the denial as an error.

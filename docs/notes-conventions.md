# Workspace Notes — Conventions

> The `.sandbox/notes/` layer specced in
> [jit-context-system.md](jit-context-system.md) (§5.7). This file is
> the canonical convention reference for anything that reads or writes notes: the
> generated CLAUDE.md `## Notes` pointer, the `sb-implement` / `sb-research` /
> `sb-handoff` skills, subagent return contracts, and `sandbox down` printing.

## What notes are

**Feature-lifetime working state, not documentation.** Notes persist context across the
three boundaries where it is otherwise lost: subagent → main agent, session → session,
and phase → phase. They live and die with the workspace.

Three rules keep the layer honest:

1. **Generated files point; notes persist.** The workspace CLAUDE.md links to
   `.sandbox/notes/` and holds no durable state. Generators (`sandbox init-workspace`,
   `sandbox up`) never write into the notes directory — with two one-time, write-once
   exceptions in init-workspace: the salvage of a legacy CLAUDE.md `## Handoff Notes`
   section into a `contract` note, and seeding the workspace's `starting_prompt` as its
   first `handoff` note (`author: workspace-creation`; skipped if any handoff note
   exists, so it never duplicates or resurrects; a later edit to `workspace.yml`'s
   `starting_prompt` does not update the note).
2. **Writes are contracted; reads are phase-entry.** Notes never emerge spontaneously
   (measured: 0/3 uncontracted) — they are written by return contracts, the `sb-handoff`
   skill, and the `sb-implement` capture rule. They are read at phase entry by the
   `sb-research` / `sb-implement` skills (measured: 3/3 with an entry skill, 2/3 with a
   pointer alone).
3. **Graduation is explicit.** Knowledge that outlives the feature moves *out*
   deliberately: per-repo quirks → `docs/standards/repos/*`, process lessons →
   auto-memory, interface contracts → the PR description. `sandbox down` prints
   surviving notes so the human decides what graduates — nothing is auto-published.

## Layout

One note per file under the workspace's `.sandbox/notes/`, numbered in creation order:

```
.sandbox/notes/
  001-finding-paginate-off-by-one.md
  002-decision-pagination-1-indexed.md
  003-attempt-cursor-based-fix.md
  004-handoff-2026-07-04-session-end.md
```

Filename: `NNN-<type>-<slug>.md` — zero-padded 3-digit sequence, one of the five types
below, kebab-case slug.

## Frontmatter schema

```yaml
---
type: finding | decision | attempt | handoff | contract
phase: research | implement | test | review
author: main | <subagent name>          # who wrote it
refs: [src/paginate.ts, frontend]     # files / services it concerns
status: open | superseded               # supersede, don't delete — attempts especially
---
```

## Types

| Type | Captures | What is lost without it |
|------|----------|-------------------------|
| `finding` | Research output: root cause, evidence with `file:line` refs, proposed fix | The investigation, when only a summary returns from a subagent |
| `decision` | Settled choices + why — workspace-scoped "don't re-litigate" | The rationale, re-argued every session |
| `attempt` | Tried-and-failed approaches | The most valuable and most-lost context: the next session re-tries the dead end |
| `handoff` | Phase/session transition state: done / in-flight / next / open questions | Resumability across sessions and compaction |
| `contract` | Cross-repo interface changes (API schema, shared types, events) | Coordination when switching repos mid-feature |

## Rules for readers

- **List the directory at phase entry** — there is no compiled index; a fresh
  convention-read needs zero machinery.
- **Skip `status: superseded` notes.**
- **`decision` notes are binding.** They override task-level instincts (minimal-change,
  stylistic preference, "the prompt didn't mention it"). If a decision note conflicts
  with the task as given, raise the conflict to the user — do not silently pick either
  side.

## Rules for writers

- Take the next free `NNN`; never renumber existing notes.
- Supersede, don't delete: set `status: superseded` on the old note (a new `handoff`
  supersedes the previous one; a revisited `decision` supersedes its predecessor).
- Keep notes small and typed — a note that needs three types is three notes.
- Write at the moment of loss, not at session end: when a decision settles, an approach
  is abandoned, or a contract changes, the "why" is still in context *now* and often
  compacted away by handoff time.

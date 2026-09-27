---
name: sb-research
description: "Begin the research/planning phase in a sandbox workspace. Use when exploring the codebase, investigating a bug, or planning an approach — any read-only work BEFORE code will be written or edited."
---

# sb-research — enter the research phase

- **Step 0 — read the workspace notes.** List `.sandbox/notes/` and read relevant `finding`
  and `attempt` notes (skip `status: superseded`). Do **not** re-research answered
  questions or re-try failed approaches. Continue if empty.
- Do **not** load code standards (`sb-*-standard` skills, `ponytail`) — they govern
  writing, not read-only work.
- **Establish scope before spawning.** Ask the user (AskUserQuestion) to settle:
  - **In scope vs. out** — which repos/services may be touched.
  - **Spike or ship-ready** — feasibility spike vs. buildable design.
  - **The givens** — assumptions held constant. Workspace `decision` notes are binding.
  - **Deliverable shape** — options analysis (default), ADR, or research story.
- **Spawn the workspace's `sb-researcher` agent** (`.claude/agents/sb-researcher.md`)
  with task, scope, givens, and deliverable shape. It carries the investigation method,
  cannot edit source files, and writes findings to `.sandbox/notes/NNN-finding-*.md`
  with a summary and note path. If unavailable, do research inline under the same
  rules — read, search, reason only — and write the `finding` note yourself.
- **Read what you reason against.** Delegate broad searches whose dumps are throwaway
  ("who imports X"); read inline anything a correctness claim rests on (`decision`
  notes, function behavior); verify delegated conclusions firsthand before they become
  load-bearing for shipped code.
- Relay the researcher's summary **and note path**, then ask the user (AskUserQuestion)
  to resolve OPEN QUESTIONS / AMBIGUITIES **before** the next phase.

## Exit

When turning to code, invoke `sb-implement` first — it loads the universal base and
domain standards before the first edit.

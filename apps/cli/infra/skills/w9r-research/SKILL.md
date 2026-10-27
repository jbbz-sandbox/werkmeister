---
name: w9r-research
description: "Begin the research/planning phase in a workspace. Use when exploring the codebase, investigating a bug, or planning an approach — any read-only work BEFORE code will be written or edited."
---

# w9r-research — enter the research phase

- **Step 0 — start the issue, then read workspace notes.** Run `werkmeister issue start`:
  it moves the workspace's issue to In Progress the first time, and does nothing once
  it is past that or when the tracker refuses. Read relevant `finding` and `attempt` notes in
  `.werkmeister/notes/` (skip `status: superseded`); never redo answered
  questions or failed approaches. Continue if empty.
- Skip code standards (`w9r-*-standard`, `ponytail`); they govern writing.
- **Establish scope before spawning.** Settle these — ask the user (AskUserQuestion)
  for any the task leaves ambiguous:
  - **In scope vs. out** — which repos/services may be touched.
  - **Spike or ship-ready** — feasibility spike vs. buildable design.
  - **The givens** — assumptions held constant. Workspace `decision` notes are binding.
  - **Deliverable shape** — options analysis (default), ADR, or research story.
- **Spawn the workspace's `w9r-researcher` agent** (`.claude/agents/w9r-researcher.md`)
  with task, scope, givens, and deliverable shape. It carries the investigation method,
  cannot edit source files, and writes findings to `.werkmeister/notes/NNN-finding-*.md`
  with a summary and note path. If unavailable, research inline under the same
  rules (read, search, reason only) and write the `finding` note yourself.
- **Read what you reason against.** Delegate broad searches whose dumps are throwaway
  ("who imports X"); read inline anything a correctness claim rests on (`decision`
  notes, function behavior); verify delegated conclusions firsthand before they become
  load-bearing for shipped code.
- Relay the summary **and note path**; resolve OPEN QUESTIONS / AMBIGUITIES with
  the user (AskUserQuestion) **before** the next phase.

## Exit by work type

Read Work type in CLAUDE.md; none → architectural.

- **architectural**: spec deliverable. Present the design in chat (scope,
  approach, what's out); explicit yes → write `NNN-decision-<slug>.md`,
  `status: decided`, recording the answers and approved design. Never
  without yes; never re-ask; unsure → ask.
- **bounded**: root cause in a `finding` note; confirm the fix direction in
  one sentence.
- **spike**: findings only, no `w9r-implement`
- **Ratchets up, never down**: design change → architectural; decision
  note first

Once the exit note exists and you turn to code, invoke `w9r-implement`
first; spikes don't.

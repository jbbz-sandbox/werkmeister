---
name: sb-research
description: "Begin the research/planning phase in a sandbox workspace. Use when exploring the codebase, investigating a bug, or planning an approach — any read-only work BEFORE code will be written or edited."
---

# sb-research — enter the research phase

- **Step 0 — read the workspace notes.** List `.sandbox/notes/` and read the `finding`
  and `attempt` notes relevant to the task (skip `status: superseded`). Do **not**
  re-research a question a `finding` answers or re-try an approach an `attempt` records
  as failed. Missing or empty directory → continue.
- Do **not** load any code standards (`sb-*-standard` skills, `ponytail`) — they govern
  writing code, and this phase is read-only.
- **Establish scope before spawning.** Settle these with the user (AskUserQuestion) when
  the task leaves them ambiguous — a wrong scope assumption compounds through everything
  downstream, and an unscoped agent silently expands its own mandate:
  - **In scope vs. out** — which repos/services may be touched vs. treated as fixed.
  - **Spike or ship-ready** — a throwaway feasibility spike and a design meant to be built
    demand different depth.
  - **The givens** — settled assumptions to hold constant. A workspace `decision` note is
    a given, and it is binding.
  - **Deliverable shape** — options analysis (default), ADR, or research story.
- **Spawn the workspace's `sb-researcher` agent** (`.claude/agents/sb-researcher.md`)
  with the task, the scope, the givens, and the deliverable shape in its prompt. It
  carries the investigation method, cannot touch source files by construction, and
  writes its findings to `.sandbox/notes/NNN-finding-*.md`, returning a short summary
  plus the note path. If the agent is not available (a workspace generated before it
  existed), do the research inline under the same rules — read, search, and reason only —
  and write the same `finding` note yourself.
- **Read what you reason against.** Delegation buys window space with a layer of
  indirection. Delegate broad searches whose file dumps are throwaway ("who imports X");
  read inline anything a correctness claim will rest on (`decision` notes, the function
  whose behaviour is your safety argument); verify a delegated conclusion firsthand before
  it becomes load-bearing for shipped code.
- Relay the researcher's summary **and the note path**, then put its OPEN QUESTIONS /
  AMBIGUITIES to the user (AskUserQuestion) and let them resolve those **before**
  proposing or starting the next phase.

## Exit

When the task turns into writing code, invoke `sb-implement` first — it loads the
universal coding base and the matching domain standards before the first edit.

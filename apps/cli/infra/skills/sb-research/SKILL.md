---
name: sb-research
description: "Begin the research/planning phase in a sandbox workspace. Use when exploring the codebase, investigating a bug, or planning an approach — any read-only work BEFORE code will be written or edited."
---

# sb-research — enter the research phase

- **Step 0 — read the workspace notes.** List `.sandbox/notes/` and read the `finding`
  and `attempt` notes relevant to the task before exploring (skip `status: superseded`).
  Do **not** re-research a question a `finding` note already answers, and do **not**
  re-try an approach an `attempt` note records as failed. If the directory is missing or
  empty, continue.
- Do **not** load any code standards (`sb-*-standard` skills, `ponytail`) — they govern
  writing code, and this phase is read-only. Loading them here wastes context and weakens
  the phase gate.
- **Spawn the workspace's `sb-researcher` agent** (generated into
  `.claude/agents/sb-researcher.md`) to do the investigation — it cannot touch source
  files by construction and keeps the exploration bulk out of this conversation. Its
  return contract writes the full findings to a `.sandbox/notes/NNN-finding-*.md` note
  and returns a short summary plus the note path. If the agent is not available (a
  workspace generated before it existed), do the research inline under the same rules:
  read, search, and reason only — never edit source files — and write the same
  `finding` note yourself before reporting (next free `NNN`, frontmatter per the note
  conventions in `.sandbox/notes/`).
- Relay the researcher's summary **and the note path** (read the note if the user needs
  detail), then put its OPEN QUESTIONS / AMBIGUITIES to the user (AskUserQuestion) and
  let them resolve those **before** proposing or starting the next phase.
## How to conduct the investigation

This governs the *investigation and its deliverable* — not the code artifact. It
is hard-scoped to this phase: it never loads at implement/review time, which is
why "present options, don't pick" can't leak into a resolver edit where it would
be actively wrong.

### Establish scope first

Settle these before investigating anything — a wrong scope assumption compounds
through everything downstream, and an unscoped agent silently expands its own
mandate:

- **In scope vs. out.** Which repos/subgraphs may be touched vs. treated as fixed.
  Name the out-of-scope explicitly.
- **Spike or ship-ready.** A throwaway feasibility spike and a design meant to be
  built demand very different depth. Confirm which.
- **The givens.** List the settled assumptions to hold constant (see below).

If any is ambiguous, surface it and ask (AskUserQuestion) rather than guessing.

### Present options, don't pick

- **Default to 2–3 viable approaches with explicit tradeoffs.** Recommend if
  asked, but the human makes the call. Silently converging on one option and
  designing only that is the single most common research over-reach.
- **Check whether it already exists first.** Before proposing anything new, search
  for an existing pattern, resolver, service, or utility that already solves this
  (the `sb-researcher` agent does this by construction). State what you looked for
  and what you found — or didn't.

### Tag every non-trivial claim by how you know it

In the `finding` note the researcher writes, mark each claim:

- **Verified** — confirmed by reading the actual code/config/schema. Cite the
  file/path.
- **Inferred** — reasoned from adjacent evidence, not directly confirmed. Say what
  the inference rests on.
- **Assumed** — a given or a reasonable default, unconfirmed. Flag it so a reviewer
  can challenge it.

Never present inferred or assumed as verified — that is how a hallucinated API,
config key, or resolver signature leaks into a design that then gets built on a
false premise. An honest "I couldn't confirm X" beats a confident guess.

### Anti-relitigation

Hold the listed givens constant. If a given genuinely looks wrong, don't quietly
design around it — flag it as a *separate* finding ("this assumption may not hold,
because…") and keep it out of the main recommendation. The human decides whether
to reopen it. (A workspace `decision` note is such a given, and it is binding —
raise the conflict, don't silently override it.)

### Bound the investigation

Prefer the smallest investigation that answers the question with adequate
confidence — don't read every file in a repo when three answer it. If the
investigation balloons past its budget, stop and report what you have plus what's
still open, rather than silently spending more. (This ceiling is on the
*investigation*, distinct from the product's performance budget.)

### Validate against the code standards — named, not loaded

Before finalizing, check each proposed option against the code-phase constraints
in `sb-engineering-standard` (architectural fit, additive/reversible change,
performance budgets, PR sizing) and any domain standard the change would touch
(e.g. `sb-service-standard`). Do **not** load those skills here — this phase stays
read-only; name them as the validation target so the option analysis is honest
about fit. An option that violates a standard is not viable — fix it or record the
violation as a tradeoff, before a human spends review time on a design that can't
ship.

### Deliverable shape

Confirm the target format up front; the deliverable must converge on something a
human can act on, not sprawl. Default to one of:

- **Options analysis** (common case): scope & givens · existing prior art · options
  (each with approach, tradeoffs, standards fit, evidence tags) · recommendation
  (if requested) · open questions / unverified assumptions.
- **ADR** — a single decision to record: context, decision, alternatives, both
  directions of consequence.
- **TRE research story** — feeds Jira: problem statement, findings, proposed
  approach, acceptance criteria, links to verified sources.

## Exit

- When the task turns into writing code, invoke `sb-implement` first — it loads the
  universal coding base and the matching domain standards before the first edit.

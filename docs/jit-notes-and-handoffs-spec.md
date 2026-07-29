# Structured Notes & Handoffs — Design Spec

> **Status:** Build steps 1–4 SHIPPED 2026-07-04 (conventions + CLAUDE.md migration,
> entry-skill read steps, `sb-handoff`, `sandbox down` printing — see §5). Steps 5–6
> unbuilt. Third companion in the JIT context-management family:
> [jit-standards-loading-spec.md](jit-standards-loading-spec.md) gates *rules*,
> [jit-agents-and-tools-spec.md](jit-agents-and-tools-spec.md) gates *tools + isolation*,
> this spec adds the **write side** — persistence of working context across agents,
> phases, and sessions.
> **Author:** design session 2026-07-04, distilled from
> [context-management-research.md](context-management-research.md) §5b (threads 11–13).
> **Scope:** sandbox. Affects `apps/cli/src/lib/claude_md.ts`, `apps/cli/src/commands/down.ts`,
> `plugins/sandbox-tools/skills/` (entry skills + a new `sb-handoff`), and — jointly with
> the agents spec — the generated subagent return contracts. Adds a `.sandbox/notes/`
> convention to every workspace.
> **Evidence base:** harness 4 —
> [experiments/context-management/results/RESULTS.md](experiments/context-management/results/RESULTS.md).

## 1. Summary

Everything shipped so far is **read-side**: it decides what flows *into* a context window.
Nothing manages what flows *out*. Context is lost at three boundaries — subagent → main
agent (only a summary returns; compaction eventually eats even that), session → session
(findings, decisions, and failed attempts vanish with the window), and phase → phase in the
HITL dispatcher model. In ICM terms, we adopted Layers 0–3 and skipped **Layer 4, the
working layer**.

The design: a `.sandbox/notes/` directory per workspace holding small **typed notes**
(finding / decision / attempt / handoff / contract). Subagent **return contracts write**
notes; **phase-entry skills read** them; the generated CLAUDE.md **points, never contains**.
Handoffs live here — today's `## Handoff Notes` section in the generated CLAUDE.md is
clobbered by every `sandbox init-workspace` re-run (`_warn_if_existing` → "overwriting with
fresh content"), a standing defect this spec retires.

## 2. Measured foundations (harness 4, 2026-07-04, N=3/arm, sonnet)

1. **The write contract works: 3/3 compliance, 0/3 discipline breaches.** A research
   subagent whose definition carries a note-writing return contract wrote a well-formed
   finding note every trial and never touched source — even though the contract requires
   granting it `Write` (the feared weakening of harness 3's read-only gate did not
   materialize).
2. **Notes never happen spontaneously: 0/3 without the contract.** The contract *is* the
   mechanism, not a formality.
3. **The read side replicates the harness-2 pattern.** Notes on disk with nothing pointing
   at them: 0/3 discovered. A CLAUDE.md pointer: 2/3 (soft gate). Pointer + entry skill:
   **3/3 read-before-edit** — the 15/15 phase-entry mechanism generalizes from standards to
   notes.
4. **New failure mode: read-but-not-applied (1/3 in the entry arm).** The model read the
   binding decision note and still favored the prompt's "smallest correct change" over the
   note's mandate. Reading can be made deterministic; *application* competes with task
   framing. The entry skills therefore carry explicit conflict-precedence wording (§4.4);
   its effectiveness is a follow-up measurement, not yet a validated guarantee.

## 3. Conceptual model

**Notes are feature-lifetime working state, not documentation.** They live and die with the
workspace. Three rules keep the layer honest:

1. **Generated files point; notes persist.** The CLAUDE.md is a compiled projection and
   holds no durable state — it links to `.sandbox/notes/`. The generator never writes into
   the notes directory (the same edit-surface precedent as `workspace.yml`
   `standards_override`).
2. **Writes are contracted; reads are phase-entry.** Both measured: contracts because notes
   never emerge spontaneously (finding 2), phase entry because pointers alone miss
   (finding 3).
3. **Graduation is explicit.** Knowledge that outlives the feature moves *out* deliberately:
   per-repo quirks → `docs/standards/repos/*`, process lessons → auto-memory, interface
   contracts → the PR description. Auto-memory is not a substitute — it is keyed to project
   *path* (never follows a feature across workspaces), invisible to subagents, and
   Claude-Code-specific.

## 4. Components

### 4.1 `.sandbox/notes/` — the note store

One note per file, `NNN-<type>-<slug>.md`, ordered by creation:

```
.sandbox/notes/
  001-finding-paginate-off-by-one.md
  002-decision-pagination-1-indexed.md
  003-attempt-cursor-based-fix.md
  004-handoff-2026-07-04-session-end.md
```

Frontmatter schema:

```yaml
---
type: finding | decision | attempt | handoff | contract
phase: research | implement | test | review
author: main | <subagent name>          # who wrote it
refs: [src/paginate.ts, web-v2]         # files / services it concerns
status: open | superseded               # supersede, don't delete — attempts especially
---
```

Types map to what is lost today:
- **finding** — research output: root cause, evidence with `file:line` refs, proposed fix.
- **decision** — settled choices + why. Workspace-scoped "don't re-litigate."
- **attempt** — tried-and-failed approaches; the most valuable and most-lost context.
- **handoff** — phase/session transition state: done / in-flight / next / open questions.
- **contract** — cross-repo interface changes (subsumes today's CLAUDE.md Handoff Notes).

No compiled index (decided, revisitable): agents list the directory at phase entry —
convention-read is always fresh and needs zero machinery. Compile an index into CLAUDE.md
only if reads demonstrably miss at scale.

**Acceptance:** notes survive `sandbox init-workspace` re-runs and `sandbox up` regens
untouched; a note with `status: superseded` is skipped by readers.

### 4.2 CLAUDE.md migration — point, never contain

`build_claude_md()` (apps/cli/src/lib/claude_md.ts) changes:
- The `## Handoff Notes` free-text section is **removed**. In its place a generated
  `## Notes` section renders the pointer: where notes live, the type taxonomy one-liner,
  and the read rule ("list and read relevant notes before starting work; `decision` notes
  are binding — see §4.4 precedence").
- The multi-repo cross-repo-contract guidance moves into the pointer text ("record contract
  changes as `contract` notes before switching repos").

**Acceptance:** regenerating CLAUDE.md loses no handoff content because there is none to
lose; the pointer section renders identically on every regen; a workspace with existing
notes keeps them across regen.

### 4.3 Write side — return contracts, `sb-handoff`, and main-agent capture

Three writers:

1. **Subagent return contracts** (jointly owned with the agents spec §4.2). Every generated
   subagent definition gains a contract block (the harness-4-measured template):
   *before returning, write your full findings to `.sandbox/notes/NNN-<type>-<slug>.md`
   (frontmatter shape above); return only a 2–3 sentence summary plus the note path.*
   The researcher's `tools:` line grows `Write` — measured safe (finding 1), and the
   role-framing + "do not modify source files" line stays as defense-in-depth.
2. **`sb-handoff`** — a thin skill invoked at session pause/end (or by the dispatcher
   between phases): write a `handoff` note capturing done / in-flight / next / open
   questions, superseding the previous handoff note. This is the sanctioned home for what
   `gsd-pause-work`-style flows do ad hoc.
3. **Main-agent capture rule** (gap review 2026-07-04). Implement happens in the *main*
   agent (HITL decision) — which is exactly where decisions settle and approaches fail, and
   it has no return contract. `sb-implement` gains a capture rule: *when a decision
   settles, an approach is abandoned, or a cross-repo contract changes, write the
   corresponding note **then** — not at session end* (by handoff time the "why we abandoned
   approach A" detail is often already compacted away). **Provisional until measured:**
   harness-4 finding 2 (uncontracted writes never happen) warns that an in-body rule may
   under-fire; measure mid-session capture compliance before relying on it (§6).

**Acceptance:** a spawned researcher on an investigate task leaves a `finding` note and an
untouched source tree (the harness-4 write arm, now against the real generated agent);
`/sb-handoff` produces a valid `handoff` note that a fresh session can resume from.

### 4.4 Read side — entry skills + precedence

`sb-implement` and `sb-research` (shipped, standards spec §5.6) each gain a notes step:

- `sb-research`, step 0: *list `.sandbox/notes/`; read `finding` and `attempt` notes
  relevant to the task before exploring — do not re-research what a note already answers,
  and do not re-try an approach an `attempt` note records as failed.*
- `sb-implement`, step 1½ (after the universal base, before editing): *read `decision`,
  `contract`, and the latest `handoff` note.* Plus the conflict-precedence rule motivated
  by finding 4:

  > `decision` notes **override task-level instincts** (minimal-change, stylistic
  > preference, "the prompt didn't mention it"). If a decision note conflicts with the
  > task as given, raise the conflict to the user — do not silently pick either side.

**Acceptance:** the harness-4 read arms re-run against the real skills reproduce ≥ the
measured rates (3/3 read-before-edit); the precedence wording measurably reduces
read-but-not-applied at N≥10 (follow-up harness run — see §6).

### 4.5 Hooks at the involuntary boundaries — PreCompact / SessionStart (gap review 2026-07-04)

Notes writes and reads as specced above are **voluntary** (a skill invocation, a return
contract) — but the two events that actually destroy context are **involuntary**:
compaction mid-session, and a fresh session that never invokes an entry skill (harness 4's
read arms invoked `exp-implement` explicitly in the prompt; a real user often won't). Wire
the notes layer to both with hooks — zero standing context cost, deterministic where the
CLAUDE.md pointer alone measured only 2/3:

- **`PreCompact`** — injects an instruction to write/refresh the `handoff` note *before*
  the window is squashed. Compaction is precisely the moment "what am I doing and why"
  evaporates; this converts it into a checkpoint.
- **`SessionStart`** — injects the latest `handoff` note (or its path + the notes pointer)
  into the fresh window, so resumption does not depend on the model choosing to read
  CLAUDE.md's Notes section or the user remembering to invoke a phase skill.

Both are emitted into the workspace's generated `.claude/settings.json` by the same
generator flow that writes the other projections (do-not-hand-edit header applies). This is
consistent with spec-family precedent: the standards spec rejected `PreToolUse` hooks
because they fire *too late to prevent* — these two hooks have no such flaw, since neither
guards a generation pass; they bracket window death and window birth.

**Amended 2026-07-04 (build step 5, after the mandated semantics verification):** the
official hooks docs rule out the PreCompact half — **PreCompact output never reaches the
model** (it can run shell commands or block compaction; no `additionalContext`, stdout is
not injected), so a hook cannot ask the model to write a handoff before the squash.
Meanwhile **SessionStart fires with a `compact` source when the post-compaction window
starts**, and its stdout/`additionalContext` does land in model context. Revised design,
as built:

- **One matcher-less `SessionStart` hook** covers *both* involuntary boundaries — fresh
  sessions (startup/resume/clear) and window rebirth after compaction. It runs
  `sandbox notes context` (PATH-guarded, `|| true`), which prints the notes pointer +
  latest `handoff` + open `decision` notes (plain text, per-body cap under the 10k hook
  output limit; silent with no notes; never exits non-zero).
- **No PreCompact hook.** The write side at compaction falls back to the §4.3.3
  mid-session capture rule ("write at the moment of loss") and `sb-handoff` — one more
  reason capture-rule compliance (§6.5) is worth measuring.
- settings.json legitimately holds user entries and JSON carries no comment header, so
  the generator **merges** instead of clobbering: it owns exactly the entries containing
  its command marker, replaces stale ones, preserves everything else, and leaves
  unparseable files untouched.
- Trust gotcha (docs): project-scope `.claude/settings.json` hooks only fire after the
  user trusts the workspace folder — acceptable, since the user creates these
  workspaces themselves; headless `-p` runs load hooks unless `--bare`.

**Amended 2026-07-04 (starting prompt = first handoff):** the workspace-creation layer
joins the notes layer at the source, not in the hook. A starting prompt *is* a handoff —
from the workspace creator to the first session — so `init-workspace` seeds it as the
workspace's first `handoff` note (`NNN-handoff-starting-prompt.md`, `author:
workspace-creation`, body framed as not-yet-begun state with confirm-with-the-user
wording, per HITL). It then flows through every existing mechanism with no special
casing: SessionStart injection, entry-skill reads, `sandbox down` printing — and the
first real `sb-handoff` supersedes it naturally, which is the staleness rule (in-flight
state outranks the creation-time snapshot). Seeding is **write-once**: only while the
workspace has no handoff note of *any* status, so re-init never duplicates and a
superseded starting prompt never resurrects. `workspace.yml` remains the input source
of truth (feeds `/sandbox-starting-prompt` and re-inits); editing it after seeding does
not update the note. (This supersedes the same-day "starting-prompt pointer" amendment,
which special-cased the hook target instead.)

**Acceptance (as amended):** a brand-new session in a workspace with notes sees the
latest handoff without any skill invocation — including the session that starts after a
compaction; the hook no-ops harmlessly in a workspace with no notes, outside a
workspace, and on machines without `sandbox` on PATH; regeneration never duplicates the
hook nor disturbs user-added settings.

### 4.6 Teardown — print, don't exfiltrate (decided 2026-07-04)

`sandbox down` prints the latest `handoff` note and all `status: open` `decision` notes to
the terminal before removing the workspace. No automatic writes to PR bodies or Jira —
the human decides what graduates (§3 rule 3).

**Acceptance:** `sandbox down` on a workspace with notes shows them; `down` on a
notes-less workspace is unchanged; printing failures never block teardown.

## 5. Build plan (sequenced, each independently shippable)

1. **Conventions + CLAUDE.md migration** (§4.1, §4.2) — **SHIPPED 2026-07-04.**
   Conventions in [notes-conventions.md](notes-conventions.md); `apps/cli/src/lib/notes.ts` owns
   the shared plumbing; `build_claude_md` renders the `## Notes` pointer;
   `init-workspace` creates `.sandbox/notes/` and salvages filled-in legacy
   `## Handoff Notes` content into a `contract` note before regen. Tests:
   `apps/cli/src/lib/__tests__/notes.test.ts`.
2. **Entry-skill read steps + precedence wording + main-agent capture rule** (§4.4,
   §4.3.3) — **SHIPPED 2026-07-04** (edited `sb-implement` / `sb-research` bodies;
   hand-authored, no generator change).
3. **`sb-handoff` skill** (§4.3.2) — **SHIPPED 2026-07-04.**
4. **`sandbox down` printing** (§4.6) — **SHIPPED 2026-07-04** (`_print_notes` in
   `apps/cli/src/commands/down.ts`, resolved via the promoted `workspace_for_feature`).
5. **SessionStart hook** (§4.5, as amended) — **SHIPPED 2026-07-04.** Semantics
   verified against the official hooks docs first (PreCompact can't inject → dropped;
   SessionStart's `compact` source covers post-compaction rebirth). `apps/cli/src/lib/hooks_gen.ts`
   merges the matcher-less SessionStart entry into the workspace `.claude/settings.json`
   on init-workspace (step 6c); new `sandbox notes context` (`apps/cli/src/commands/notes.ts`)
   is the hook target. Tests: `apps/cli/src/lib/__tests__/hooks_gen.test.ts`.
6. **Subagent return contracts** (§4.3.1) — **SHIPPED 2026-07-04.** The generated
   `sb-researcher` (`apps/cli/src/lib/agent_gen.ts`) now carries the harness-4-measured contract:
   list `.sandbox/notes/`, take the next free `NNN`, write
   `NNN-finding-<slug>.md` (conventions frontmatter), return a 2–3 sentence summary +
   note path + open questions. `tools:` grew `Write` (measured safe — the
   no-source-edits discipline held 3/3); the role-frame line stays as
   defense-in-depth. The `sb-research` skill relays the note path and its inline
   fallback writes the same note. Tests: `apps/cli/src/lib/__tests__/agent_gen.test.ts`. The §4.3
   acceptance re-run (harness-4 write arm against the real generated agent) stays on
   the measurement backlog.

## 6. Open questions (not blockers for steps 1–4)

1. **Read-but-not-applied at scale** — 1/3 is a single observation; bound the rate at N≥10
   and measure whether the §4.4 precedence wording fixes it (harness 4 follow-on, listed in
   RESULTS.md).
2. **Note quality drift** — contracted notes were well-formed on a clean bait task; do they
   stay structured on messy real tasks, or does the frontmatter degrade?
3. **Concurrent writers** — two subagents numbering notes simultaneously can collide on
   `NNN`. Likely fine (writers are sequential in the HITL dispatcher model); revisit if
   parallel fan-out becomes real.
4. **Handoff-resume fidelity** — does a fresh session resume *correctly* from a `handoff`
   note (vs. re-deriving state)? Unmeasured; a harness-4 variant.
5. **Main-agent capture compliance** (§4.3.3) — does an in-body capture rule fire
   mid-session, or does it under-fire like uncontracted subagent writes (0/3)? Measure
   before treating mid-session `decision`/`attempt` notes as reliable.
6. **Hook semantics across launch paths** (§4.5) — doc-verified 2026-07-04: SessionStart
   fires in interactive CLI, VS Code (after workspace trust), and headless `-p` (unless
   `--bare`); PreCompact can't inject (design amended). Still open empirically: VK-driven
   sessions, and whether the trust prompt ever silently suppresses the hook in practice.

## 7. References

- [context-management-research.md](context-management-research.md) §5b — threads 11–13,
  decisions (2026-07-04): handoffs in the notes layer; measure first; print-on-teardown.
- [experiments/context-management/results/RESULTS.md](experiments/context-management/results/RESULTS.md)
  — harness 4 write/read compliance results.
- [jit-agents-and-tools-spec.md](jit-agents-and-tools-spec.md) §4.2 — the return contract
  this spec's write side rides on.
- ICM Layer 4 (working layer) — the layer this spec supplies; Layers 0–3 are covered by the
  standards spec.

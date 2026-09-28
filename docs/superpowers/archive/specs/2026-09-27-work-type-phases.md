# Work type drives the JIT phases — spec

**Status:** proposed
**Scope:** `packages/sandbox-core` (`workspace_prompts.ts`, `claude_md.ts`, `workspace_init.ts`, `standards.ts`, `gate.ts`), `apps/cli/infra/skills/sb-research/SKILL.md`, `docs/jit-context-system.md`, `docs/notes-conventions.md`, `docs/known-issues.md`.
**Related:** `2026-09-27-context-strategy-interface.md` (option B). This spec changes what the JIT layer generates; option B changes who calls the generator. Either lands first. After B, everything here lives in `strategies/jit.ts`, and B's ICM stage templates should read the same table (§3.1) so the two strategies never disagree on what a `bugfix` is.
**Evidence:** `~/features/COMPARISON.md` run 2; known-issues "Answers Given in Chat Are Not Persisted, So Later Phases Re-Ask" and "Generated CLAUDE.md Task Title Competes With the Starting Prompt"; the superpowers `brainstorming` skill's three-path model (spike / bounded / architectural).

## 1. Problem

The wizard asks for a work type and the JIT layer then drops it. `WORK_TYPE_PHASES` (`workspace_prompts.ts:290`) maps each type to one starting phase and one hint sentence, and the only consumer is `seedStartingHandoff` (`workspace_init.ts:743`), which writes them into the first handoff note's frontmatter and body. The "By phase" table and the "Phase entry" paragraph in the generated CLAUDE.md (`claude_md.ts:229-241`) are identical for every work type: a refactor is told to research first, a spike is told how to open a PR.

Two measured consequences in run 2 (jit-ws2, `feature`):

- Design answers given in chat were never written down, so a later phase re-asked them (Jira ID, the drift-test approach). Nothing in the layer names a deliverable for the research phase, so research ends in chat.
- Implementation began on a nod in chat. There is no artifact that says "approved", so nothing can check for one. The standards gate (§6 of `jit-context-system.md`) enforces that `sb-implement` ran, not that anyone agreed to what it is about to implement.

The superpowers `brainstorming` skill solves both with a hard gate (no code until the human approves a stated design) and by scaling ceremony to the task (spike / bounded / architectural). The JIT layer already has the pieces to do the same with files instead of chat: `decision` notes, `finding` notes, `sandbox notes context` re-injection, and a PreToolUse gate that reads `.sandbox/`.

## 2. Goals

1. The work type selects the phase sequence rendered in CLAUDE.md and the entry-skill hint in the seeded handoff. A refactor never sees a research row; a spike never sees an implement or PR row.
2. Each work type names the artifact that ends its first phase. For `feature` that artifact is the spec: a `decision` note. For `bugfix` and `incident` it is a `finding` note naming the root cause.
3. Approval is a file, not a chat message. `feature` work cannot edit source until a `decision` note reads `status: decided`. The same flip is ICM's approval in `~/features/icm-ws2`.
4. The gate enforces goal 3 with the same fail-open, dependency-light rules as the standards gate, and with `.sandbox/**` exempt so the note that satisfies the gate can be written.
5. Existing workspaces regenerate to the new CLAUDE.md on their next `init-workspace`. An unknown or missing work type behaves as today (research first, no phase gate).

Non-goals: a separate `spec` phase or `sb-spec` skill (the spec is the research phase's exit artifact); a `writing-plans`-style task plan for `implement`; changing `sb-implement`, `sb-test`, `sb-review`, `sb-pr`; tightening the `work_type` schema (the wizard's "Other" stays legal); depending on the superpowers plugin being installed.

## 3. Design

### 3.1 The table

Replace the tuple with a plan. `workspace_prompts.ts`:

```ts
export type Phase = "research" | "implement" | "test" | "review" | "pr";
export type PhasePath = "spike" | "bounded" | "architectural";

/** What must exist in .sandbox/notes/ before the first source edit. */
export interface PhaseGate {
  note: "decision" | "finding";
  status?: "decided";          // absent = any non-superseded note of that type
}

export interface WorkTypePlan {
  path: PhasePath;
  phases: Phase[];             // rendered in this order
  gate: PhaseGate | null;      // null = no phase gate (standards gate still applies)
  hint: string;                // one sentence for the seeded handoff, as today
}

export const WORK_TYPE_PHASES: Record<string, WorkTypePlan> = {
  feature: {
    path: "architectural",
    phases: ["research", "implement", "test", "review", "pr"],
    gate: { note: "decision", status: "decided" },
    hint: "invoke `sb-research` first — it ends in a `decision` note the user approves before any code",
  },
  bugfix: {
    path: "bounded",
    phases: ["research", "implement", "test", "pr"],
    gate: { note: "finding" },
    hint: "invoke `sb-research` first to reproduce and write the root cause to a `finding` note before changing code",
  },
  incident: {
    path: "bounded",
    phases: ["research", "implement", "test", "pr"],
    gate: { note: "finding" },
    hint: "invoke `sb-research` first to diagnose; the `finding` note is the incident record",
  },
  refactor: {
    path: "bounded",
    phases: ["implement", "test", "review", "pr"],
    gate: null,
    hint: "invoke `sb-implement` first — the scope is known and standards matter most",
  },
  spike: {
    path: "spike",
    phases: ["research"],
    gate: null,
    hint: "invoke `sb-research` first to frame the questions; anything built is throwaway and there is no PR",
  },
};

export const DEFAULT_PLAN: WorkTypePlan = {
  path: "architectural",
  phases: ["research", "implement", "test", "review", "pr"],
  gate: null,
  hint: "invoke `sb-research` first",
};

export function planFor(workType: string): WorkTypePlan {
  return WORK_TYPE_PHASES[workType.trim().toLowerCase()] ?? DEFAULT_PLAN;
}
```

`WORK_TYPES` and the wizard `pattern` keep reading `Object.keys(WORK_TYPE_PHASES)`; nothing else about the wizard changes. The `work_type` `help` string becomes "What kind of work this is; selects the phase sequence and the pre-implementation gate in CLAUDE.md."

Why `bugfix` gates on a `finding` and not a `decision`: brainstorming's bounded path asks for a stated intent, not a spec. The root cause written down is that statement, and `sb-research` already writes it. Why `spike` has no gate: its output is an answer, and code it produces is labelled throwaway, so a gate would only tax the throwaway.

Why no `spec` phase: the spec for a `feature` is the `decision` note that research produces. Adding a phase with no skill behind it would put a row in CLAUDE.md that nothing can enter. The note is where the answers persist (goal 2), and its status is what the gate reads (goal 3).

### 3.2 CLAUDE.md

`buildStandardsRoutingSection(active, notActive, modules, repoNames, plan: WorkTypePlan)`. Two changes to the rendered block:

1. A **Work type** line above "Phase entry", and a "Phase entry" sentence built from `plan.phases` only:

   ```
   **Work type:** feature (architectural path) — phases: research → implement → test → review → pr.
   Gate: no source edit until a `decision` note in `.sandbox/notes/` reads `status: decided`. Write it at the end of research, after the user approves the design; the flip *is* the approval — do not ask again.
   ```

   For `bugfix`/`incident`: "Gate: no source edit until a `finding` note names the root cause." For `refactor`: "Gate: none — `sb-implement` loads the standards." For `spike`: "No implement, review, or PR phase. Deliverable: `finding` notes. Anything built is throwaway."

2. The **By phase** table keeps only the rows in `plan.phases`, in that order. Row text is unchanged.

The "Phase entry" paragraph is rebuilt from a `Record<Phase, string>` of the five existing clauses, joined for `plan.phases` only. The routing table, Active/Not active lines, and the Notes section are untouched.

`buildClaudeMd` gains a `workType: string` parameter after `meta`; `initWorkspace` passes `inputs["work_type"] ?? ""` and calls `planFor` once, sharing the plan with `seedStartingHandoff` (which takes `plan.hint` in place of the tuple's second element and `plan.phases[0]` as the note `phase`).

### 3.3 The manifest

`buildStandardsManifest(active, modules, plan)` adds one key to `.sandbox/standards.json`:

```json
"phase_gate": { "note": "decision", "status": "decided" }
```

or `"phase_gate": null`. The gate module must not parse YAML (it runs on every Edit/Write and is builtins-only by design), so init compiles the plan into the manifest it already reads. This keeps the §6 rule that the manifest is a compilation, not a second source of truth.

### 3.4 The gate

`gate.ts decide()` gets one new step, before the standards logic and after the state load:

```
2a. If manifest.phase_gate is set and relPath does not start with ".sandbox/":
      scan .sandbox/notes/*-<note>-*.md; a note satisfies the gate when its
      frontmatter has no `status: superseded` / `status: graduated` line and,
      if phase_gate.status is set, has a line `status: <that value>`.
      No satisfying note → return the phase-gate deny text. Do not record
      delivery: the deny repeats on every source edit until the note exists.
```

Deny text, `feature`:

> Phase gate: this is a **feature** workspace and no `decision` note in `.sandbox/notes/` has `status: decided`. Invoke `sb-research`, present the design to the user, and when they approve write `NNN-decision-<slug>.md` with `status: decided` recording what was approved. Then retry this edit. Edits under `.sandbox/` are not gated.

Deny text, `bugfix`/`incident`: the same shape naming a `finding` note and "the root cause".

Two deliberate departures from the standards gate, both recorded here so §6 of the JIT doc can state them:

- **Deny-until, not deny-once.** The standards gate denies once and trusts the model to load the skill. The phase gate is an approval gate. A once-only deny would mean "acknowledge that you skipped approval, then proceed", which is the failure the gate exists to stop. The note is the only key, and writing it costs one Write.
- **No state.** Because it is deny-until, the phase gate writes nothing to `.sandbox/.gate/`. The standards gate's state handling is unchanged.

Fail-open is preserved: missing manifest, missing `phase_gate` key, unreadable notes dir, unparseable note, or a `relPath` outside the workspace all fall through to the standards logic as today. Frontmatter parsing is a `^status:\s*(\S+)` regex over the text between the first two `---` lines; no YAML library.

Manual check: `sandbox hooks gate` already reads the hook payload from stdin, so the existing test harness in `gate.test.mjs` covers it.

### 3.5 `sb-research`

Add one section after "Establish scope first", titled **Exit by work type**. It reads the "Work type" line from the workspace CLAUDE.md and does the following. Everything else in the skill stays.

- **architectural (`feature`).** The deliverable is the spec. Put open questions to the user one at a time (AskUserQuestion), present the design in chat (a few paragraphs: scope, approach, what is out), and stop. On the user's explicit yes, write `NNN-decision-<slug>.md` with `status: decided` whose body records the answers given and the design approved. Never write `decided` without that yes; never ask again once it is written. Not sure whether the user approved: ask, do not assume.
- **bounded (`bugfix`, `incident`).** The deliverable is the root cause. Write the `finding` note (the researcher agent already does) and confirm the fix direction in one sentence. No decision note unless a real choice arose.
- **spike.** Findings only. Say at the start that nothing built will be kept, and do not enter `sb-implement`.
- **Path ratchets up, never down.** A `bugfix` that turns out to need a design change becomes architectural: say so, and write the `decision` note before continuing.

### 3.6 Notes conventions

`docs/notes-conventions.md` frontmatter schema: `status: open | decided | superseded | graduated` with one line: "`decided` is the approved state of a `decision` note; the JIT phase gate and the ICM stage gate both read it. Only write it after the user has approved in their own words." `openDecisions()` in `notes.ts` already returns decided notes (it filters only superseded/graduated), so `sandbox notes context` re-injects the approved spec at every session start with no change.

### 3.7 Known issues

"Answers Given in Chat Are Not Persisted" and "Generated CLAUDE.md Task Title Competes With the Starting Prompt" each get a `Fix: this spec` pointer. The title conflict is only partially addressed (the seeded handoff now says which phase and artifact to start with, which is what the run-2 model asked about), so that entry stays open.

## 4. Tests

`packages/sandbox-core/*.test.mjs`, `node:test`, matching the existing style.

1. `workspace_prompts.test.mjs` — every `WORK_TYPE_PHASES` entry has ≥1 phase, all phases are in the `Phase` set, `refactor` lacks `research`, `spike` is exactly `["research"]`, `planFor("nonsense")` is `DEFAULT_PLAN`, `planFor(" Feature ")` is the feature plan.
2. `claude_md.test.mjs` (new) — `buildStandardsRoutingSection` for `refactor` has no `sb-research` row and no "Gate:" text mentioning a note; for `spike` has no `sb-implement` or `sb-pr` row; for `feature` names `status: decided`; the routing table rows are identical across work types.
3. `standards-check.test.mjs` — `buildStandardsManifest` emits `phase_gate` matching the plan and `null` for `refactor`.
4. `gate.test.mjs` — with a manifest whose `phase_gate` is `{note: "decision", status: "decided"}`:
   - edit `repo/src/a.ts`, no notes → deny text contains "Phase gate" and "decision"; no state file written.
   - same, plus `001-decision-x.md` with `status: open` → still deny.
   - same, plus `status: decided` → falls through to the standards logic (deny text is the standards text, or null once delivered).
   - two decision notes, one `status: superseded` and one `status: decided` → allow (superseded is skipped, not counted).
   - edit `.sandbox/notes/002-decision-y.md`, no notes → allow.
   - `phase_gate: null` → behaviour identical to today.
   - `{note: "finding"}` and a `001-finding-root-cause.md` with `status: open` → allow.
5. `workspace_init.test.mjs` — the seeded handoff for `refactor` says `sb-implement` and has `phase: implement`; for `feature` mentions `decision`.

## 5. Rollout

Two PRs, each shippable alone:

1. **Table + render + skill text.** §3.1, §3.2, §3.5, §3.6, tests 1, 2, 5. Every regenerated workspace gets the right phases and the research skill starts writing the spec. No enforcement yet.
2. **Gate.** §3.3, §3.4, §3.7, tests 3, 4. Turns the `decided` flip into a hard gate.

Rerun the jit-ws2 protocol from `~/features/COMPARISON.md` after PR 2 with the same answer sheet. Expected: zero re-asked questions, and the run-2 "asked approval mid-implementation" turns move to the end of research where they belong.

## 6. Decisions taken here

- Spec is a `decision` note, not a new phase or file type. Reuses re-injection, precedence rules, and ICM's approval convention for free.
- Phase gate is deny-until with no state; the standards gate is unchanged.
- `.sandbox/**` is exempt from the phase gate. Without this the gate is unsatisfiable.
- The model writes `decided`, not the human. JIT has no human-edited stage files; the human's approval is spoken, and the skill turns it into the file. ICM keeps its human-flipped convention.
- Unknown work type → `DEFAULT_PLAN` (research first, no gate). Matches today's fallback.

## 7. Open questions

1. Should `test` be required before `pr` for `feature`, enforced by `sb-pr` checking for a test run? Today `sb-pr` runs the suite itself, which may be enough.
2. Should the phase gate also cover `Bash` heredoc writes? The standards gate does not, and closing that hole is a separate change.
3. Whether `incident` should skip `review` is a guess from the ICM template in the option B spec. Confirm with whoever runs incidents.

# Work Type Phases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workspace's `work_type` selects the JIT phase sequence rendered in CLAUDE.md, the seeded handoff's first phase, and a pre-implementation gate that blocks source edits until a `decision` (feature) or `finding` (bugfix/incident) note exists.

**Architecture:** One table, `WORK_TYPE_PHASES` in `workspace_prompts.ts`, becomes a `WorkTypePlan` per type, read through `planFor()`. Three consumers read it: `seedStartingHandoff` (first phase + hint), `buildStandardsRoutingSection` (Work type line + filtered By-phase table), and `buildStandardsManifest` (compiles `plan.gate` into `.sandbox/standards.json` as `phase_gate`). `gate.ts decide()` reads `phase_gate` from the manifest and scans `.sandbox/notes/` with builtins only. The work ships as two PRs: Part 1 (table, render, skill text) and Part 2 (manifest + gate).

**Tech Stack:** TypeScript (ESM, ES2022), `node:test`, `tsc`. Tests are `.mjs` files in `packages/sandbox-core/` that import from `./dist/`. Run `npm test` inside `packages/sandbox-core` (it compiles first). For a single file: `cd packages/sandbox-core && npx tsc && node --test <file>.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-27-work-type-phases.md`

## Before you start

- Local `main` was 15 commits behind `origin/main` when this plan was written. The workspace-context-trim merge (PR #82) is on `origin/main` only, and every line reference below is against `origin/main` at `df0f966`. Run `git fetch && git checkout main && git merge --ff-only origin/main` first. If it refuses because untracked files would be overwritten, the blockers are the older local copies of `docs/superpowers/{plans,specs}/2026-09-26-workspace-context-trim.md`. Origin's copies are identical except for an added `**Status: done**` line, so ask the user before deleting the local ones.
- Task 6 edits two entries in `docs/known-issues.md` ("Generated CLAUDE.md Task Title Competes With the Starting Prompt" and "Answers Given in Chat Are Not Persisted, So Later Phases Re-Ask"). They exist only in the user's uncommitted working copy. Ask the user to commit them, or carry them onto the branch, before Task 6.
- Part 1: `git checkout -b feat/work-type-phases`. Commit this plan and the spec as the first commit:
  `git add docs/superpowers/specs/2026-09-27-work-type-phases.md docs/superpowers/plans/2026-09-27-work-type-phases.md && git commit -m "docs: plan and spec for work-type phases"`.
- Part 2 branches from Part 1: `git checkout -b feat/work-type-phase-gate` once Part 1's PR is open.

## Global Constraints

- The gate module stays builtins-only (`node:fs`, `node:path`). No import from `notes.ts`, `workspace_prompts.ts`, or anything that pulls in `yaml`. It runs on every Edit/Write within a <200ms budget.
- Fail-open: a missing manifest, a missing `phase_gate` key, an unreadable notes dir (other than ENOENT, see Review Focus 2), an unparseable note, or a path outside the workspace must all fall through to the existing standards logic. `decide()` never throws.
- The phase gate is deny-until and writes nothing to `.sandbox/.gate/`. The standards gate's state handling is unchanged.
- Edits under `.sandbox/` are never phase-gated.
- An empty or unknown work type renders today's CLAUDE.md byte-for-byte: all five By-phase rows, no Work type line, no gate.
- `work_type` schema is not tightened. The wizard's "Other" stays legal.
- `apps/cli/infra/skills/sb-research/SKILL.md` stays ≤ 2500 bytes. The trim commit `493bfe1` set this budget; the file is 2076 bytes today.
- Docs state current state only. Update `docs/jit-context-system.md` in the same commit as the behaviour it describes.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec (decided here, keep them)

1. **`planFor` uses `Object.hasOwn`.** The spec's `WORK_TYPE_PHASES[key] ?? DEFAULT_PLAN` returns `Object.prototype.constructor` for a free-text work type of `constructor`. That type is legal because "Other" is allowed.
2. **`buildStandardsRoutingSection` takes `workType: string = ""` as a 4th parameter, not `(active, notActive, modules, repoNames, plan)`.** The trim merge removed `notActive`. The Work type line needs the type's name, and a default keeps the existing callers and tests unchanged. `buildClaudeMd` gets **no** new parameter because it receives the section prebuilt.
3. **There is no "Phase entry" paragraph to rebuild.** The trim merge deleted it (`claude-md.test.mjs` asserts it is absent). The Work type and Gate lines go directly above the By-phase table.
4. **`phase_gate` is omitted from the manifest when the plan has no gate**, rather than emitted as `null`. If `null` were always emitted, every existing workspace would suddenly report `stale: .sandbox/standards.json` from `sandbox skills check`. The gate treats a missing key and `null` the same.
5. **The gate's deny text does not name the work type.** The manifest carries only `{note, status}`. The text is built from those two fields instead.
6. **`sandbox skills sync`/`check` also compile `phase_gate`** (`workspace_skills.ts resolveWorkspaceManifest`). The spec only lists init. Without this, `sync` strips the gate and `check` reports every gated workspace as stale.
7. **The seed test goes in `workspace-init-seed.test.mjs`** (where the seed tests live), not `workspace_init.test.mjs`. The render test goes in the existing `claude-md.test.mjs`, not a new `claude_md.test.mjs`.

## Review Focus

1. **`sandbox skills sync` on a `feature` workspace keeps `phase_gate`, and `check` does not call it stale.** Task 4's `resolveWorkspaceManifest` test pins this.
2. **A `feature` workspace with no `.sandbox/notes/` directory at all denies instead of failing open.** ENOENT means "no notes", not "unreadable". Task 5's "missing notes dir still denies" test pins this.
3. **`status: "decided"` (quoted) and CRLF line endings still satisfy the gate.** Hand-written or Windows-edited notes are common. Task 5's "quoted status with CRLF" test pins this.
4. **An edit to a path outside the workspace (`../other/x.ts`) is not phase-gated.** Task 5's "outside the workspace" test pins this.
5. **A free-text work type like `constructor` or ` Feature ` resolves sanely.** The first gets the default plan and the second gets the feature plan. Task 1's `planFor` test pins both.

---

# Part 1 — table, render, skill text (PR 1)

### Task 1: `WorkTypePlan` table and `planFor`; the seeded handoff follows it

**Files:**
- Modify: `packages/sandbox-core/workspace_prompts.ts:289-303` (the `WORK_TYPE_PHASES` tuple table) and `:329-338` (the `work_type` prompt `help`)
- Modify: `packages/sandbox-core/workspace_init.ts:60-70` (import) and `:674-690` (`seedStartingHandoff`)
- Test: `packages/sandbox-core/workspace_prompts.test.mjs`, `packages/sandbox-core/workspace-init-seed.test.mjs`

**Interfaces:**
- Produces (all exported from `workspace_prompts.ts`):
  - `type Phase = "research" | "implement" | "test" | "review" | "pr"`
  - `type PhasePath = "spike" | "bounded" | "architectural"`
  - `interface PhaseGate { note: "decision" | "finding"; status?: "decided" }`
  - `interface WorkTypePlan { path: PhasePath; phases: Phase[]; gate: PhaseGate | null; hint: string }`
  - `const WORK_TYPE_PHASES: Record<string, WorkTypePlan>`, `const DEFAULT_PLAN: WorkTypePlan`
  - `function planFor(workType: string): WorkTypePlan`
- `seedStartingHandoff(workspaceRoot, startingPrompt, workType)` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-core/workspace_prompts.test.mjs`, and add `DEFAULT_PLAN, WORK_TYPE_PHASES, planFor` to its import from `./dist/workspace_prompts.js`:

```js
const PHASES = ["research", "implement", "test", "review", "pr"];

test("every work type has phases, all drawn from the five", () => {
  for (const [type, plan] of Object.entries(WORK_TYPE_PHASES)) {
    assert.ok(plan.phases.length > 0, type);
    for (const phase of plan.phases) assert.ok(PHASES.includes(phase), `${type}: ${phase}`);
  }
});

test("refactor skips research; spike is research only", () => {
  assert.ok(!WORK_TYPE_PHASES.refactor.phases.includes("research"));
  assert.deepEqual(WORK_TYPE_PHASES.spike.phases, ["research"]);
});

test("planFor normalises the type and never returns a prototype member", () => {
  assert.equal(planFor(" Feature "), WORK_TYPE_PHASES.feature);
  assert.equal(planFor("nonsense"), DEFAULT_PLAN);
  assert.equal(planFor(""), DEFAULT_PLAN);
  assert.equal(planFor("constructor"), DEFAULT_PLAN);
});
```

Append to `packages/sandbox-core/workspace-init-seed.test.mjs`:

```js
test("the seeded handoff starts at the work type's first phase", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "Tidy the module", "refactor");
    const [note] = listNotes(ws, true);
    assert.equal(note.frontmatter.phase, "implement");
    assert.match(note.body, /invoke `sb-implement` first/);
  });
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "Ship it", "feature");
    const [note] = listNotes(ws, true);
    assert.equal(note.frontmatter.phase, "research");
    assert.match(note.body, /`decision` note/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test workspace_prompts.test.mjs workspace-init-seed.test.mjs`
Expected: FAIL. `planFor` is not exported, and the feature seed body lacks "`decision` note".

- [ ] **Step 3: Replace the table**

In `workspace_prompts.ts`, replace the comment line `// Work type → (seeded note phase, first entry-skill sentence).` and the whole `WORK_TYPE_PHASES` tuple object with:

```ts
export type Phase = "research" | "implement" | "test" | "review" | "pr";
export type PhasePath = "spike" | "bounded" | "architectural";

/** What must exist in .sandbox/notes/ before the first source edit. */
export interface PhaseGate {
  note: "decision" | "finding";
  status?: "decided"; // absent = any non-superseded note of that type
}

export interface WorkTypePlan {
  path: PhasePath;
  phases: Phase[]; // rendered in this order
  gate: PhaseGate | null; // null = no phase gate (standards gate still applies)
  hint: string; // one sentence for the seeded handoff
}

// Work type → the JIT phases, the first phase's exit artifact, and the gate
// that artifact satisfies (docs/jit-context-system.md §5.3, §6).
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

/** The plan for a free-text work type; unknown (or "Other") → {@link DEFAULT_PLAN}. */
export function planFor(workType: string): WorkTypePlan {
  const key = workType.trim().toLowerCase();
  return Object.hasOwn(WORK_TYPE_PHASES, key) ? WORK_TYPE_PHASES[key] : DEFAULT_PLAN;
}
```

Leave `const WORK_TYPES: string[] = Object.keys(WORK_TYPE_PHASES);` as it is. In the `work_type` prompt spec, replace the `help:` value with:

```ts
    help:
      "What kind of work this is; selects the phase sequence and the " +
      "pre-implementation gate in CLAUDE.md.",
```

- [ ] **Step 4: Point the seed at the plan**

In `workspace_init.ts`, change the `WORK_TYPE_PHASES,` entry in the `./workspace_prompts.js` import block to `planFor,`. In `seedStartingHandoff`, replace

```ts
  const [phase, firstSkill] = WORK_TYPE_PHASES[wt] ?? ["research", "invoke `sb-research` first"];
```

with

```ts
  const plan = planFor(wt);
```

Then change `` `phase: ${phase}`, `` to `` `phase: ${plan.phases[0]}`, `` and `` lines.push(`This workspace is a ${wt} — ${firstSkill}.`, ""); `` to `` lines.push(`This workspace is a ${wt} — ${plan.hint}.`, ""); ``.

Run `grep -rn "WORK_TYPE_PHASES" packages apps --include=*.ts | grep -v dist/`. Expected: only `workspace_prompts.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS, including the four existing seed tests. The feature hint still contains "invoke `sb-research` first".

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/workspace_prompts.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/workspace_prompts.test.mjs packages/sandbox-core/workspace-init-seed.test.mjs
git commit -m "feat(core): work type selects a phase plan, not a phase/hint pair

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CLAUDE.md renders the work type's phases and gate

**Files:**
- Modify: `packages/sandbox-core/claude_md.ts:13-20` (imports), `:113-170` (`buildStandardsRoutingSection`)
- Modify: `packages/sandbox-core/workspace_init.ts:840` (call site)
- Modify: `docs/jit-context-system.md` §5.3 (line ~246)
- Test: `packages/sandbox-core/claude-md.test.mjs`

**Interfaces:**
- Consumes: `planFor`, `DEFAULT_PLAN`, `type Phase`, `type WorkTypePlan` from Task 1.
- Produces: `buildStandardsRoutingSection(active: string[], modules: Record<string, Record<string, any>>, repoNames: string[], workType: string = ""): string`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-core/claude-md.test.mjs`:

```js
const ACTIVE = ["comments", "engineering", "ui"];
const section = (workType) => buildStandardsRoutingSection(ACTIVE, MODULES, ["demo"], workType);
const byPhase = (out) => out.slice(out.indexOf("**By phase**"));

test("refactor has no research row and no note gate", () => {
  const out = section("refactor");
  assert.doesNotMatch(byPhase(out), /`sb-research`/);
  assert.match(out, /\*\*Work type:\*\* refactor \(bounded path\) — phases: implement → test → review → pr\./);
  assert.doesNotMatch(out, /Gate:[^\n]*note/);
});

test("spike has no implement, review, or PR row", () => {
  const out = byPhase(section("spike"));
  assert.doesNotMatch(out, /`sb-implement`|`sb-review`|`sb-pr`/);
  assert.match(section("spike"), /Anything built is throwaway/);
});

test("feature names the decided gate; bugfix names the root cause", () => {
  assert.match(section("feature"), /`decision` note in `\.sandbox\/notes\/` reads `status: decided`/);
  assert.match(section("bugfix"), /`finding` note in `\.sandbox\/notes\/` names the root cause/);
  assert.doesNotMatch(byPhase(section("bugfix")), /^\| review \(/m, "the pr row still names sb-review; the review row is gone");
});

test("the active table is identical across work types", () => {
  const active = (out) => out.slice(0, out.indexOf("**By phase**"));
  const strip = (out) => active(out).replace(/\*\*Work type:\*\*[^\n]*\n[^\n]*\n\n/, "");
  for (const wt of ["feature", "bugfix", "refactor", "spike", "incident"]) {
    assert.equal(strip(section(wt)), active(section("")), wt);
  }
});

test("an empty or unknown work type renders today's section exactly", () => {
  const today = buildStandardsRoutingSection(ACTIVE, MODULES, ["demo"]);
  assert.equal(section(""), today);
  assert.equal(section("chore"), today);
  assert.doesNotMatch(today, /Work type/);
  assert.equal((byPhase(today).match(/^\| [^|]+ \| `sb-/gm) ?? []).length, 5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test claude-md.test.mjs`
Expected: FAIL. The refactor output still has an `sb-research` row and no Work type line.

- [ ] **Step 3: Implement**

In `claude_md.ts`, add to the imports:

```ts
import { DEFAULT_PLAN, planFor, type Phase, type WorkTypePlan } from "./workspace_prompts.js";
```

Above `buildStandardsRoutingSection`, add:

```ts
/** The Gate line for a plan — what must exist before the first source edit. */
function gateLine(plan: WorkTypePlan): string {
  if (plan.path === "spike") {
    return "No implement, review, or PR phase. Deliverable: `finding` notes. Anything built is throwaway.";
  }
  if (plan.gate === null) {
    return "Gate: none — `sb-implement` loads the standards.";
  }
  if (plan.gate.status) {
    return (
      `Gate: no source edit until a \`${plan.gate.note}\` note in \`.sandbox/notes/\` reads ` +
      `\`status: ${plan.gate.status}\`. Write it at the end of research, after the user approves ` +
      "the design; the flip *is* the approval — do not ask again."
    );
  }
  return `Gate: no source edit until a \`${plan.gate.note}\` note in \`.sandbox/notes/\` names the root cause.`;
}
```

Add `workType = ""` as a 4th parameter to `buildStandardsRoutingSection`, and extend the doc comment with one sentence: "*workType* selects which By-phase rows render and adds the Work type / Gate lines; an empty or unknown type renders all five rows and no gate (`DEFAULT_PLAN`)." Before the `return`, add:

```ts
  const plan = planFor(workType);
  const phaseRows: Record<Phase, string> = {
    research: "| research / planning | `sb-research` | nothing — spawns the read-only `sb-researcher` agent |",
    implement: `| implementing (before the first code edit) | \`sb-implement\` | universal base (${universalSkills}) + rows matching the files you edit |`,
    test: "| testing | `sb-test` | nothing — spawns the matching `sb-tester-<archetype>` agent(s) |",
    review: "| review (before reading any diff or PR) | `sb-review` | the standards covering files in the diff |",
    pr: "| PR / finishing | `sb-pr` | nothing — runs the pre-PR gate, then `sb-review` |",
  };
  const workTypeBlock =
    plan === DEFAULT_PLAN
      ? ""
      : `**Work type:** ${workType.trim().toLowerCase()} (${plan.path} path) — phases: ` +
        `${plan.phases.join(" → ")}.\n${gateLine(plan)}\n\n`;
```

In the template, replace the five hardcoded By-phase data rows with `${plan.phases.map((p) => phaseRows[p]).join("\n")}`, and put `${workTypeBlock}` immediately before `**By phase**`. The region must read exactly:

```ts
${rows.join("\n")}

${workTypeBlock}**By phase** — invoke the entry skill before starting the phase:

| Phase | Invoke first | Loads |
|-------|--------------|-------|
${plan.phases.map((p) => phaseRows[p]).join("\n")}

`;
```

Keep each row string byte-identical to the one it replaces. The "renders today's section exactly" test catches any drift.

- [ ] **Step 4: Wire init**

In `workspace_init.ts:840`, change the call to:

```ts
    standardsSection = buildStandardsRoutingSection(active, modules, repoNames, inputs["work_type"] ?? "");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS. The existing "states the phase chain once" test still passes because it calls without a work type.

- [ ] **Step 6: Update `docs/jit-context-system.md` §5.3**

After the sentence ending "which is the only statement of the phase chain." in §5.3, insert:

```markdown
The table's rows come from the workspace's `work_type` (`workspace_prompts.ts::WORK_TYPE_PHASES`,
read through `planFor`): a `refactor` has no research row, a `spike` has only research, and
`bugfix`/`incident` skip review. A known work type also gets a **Work type** line naming its
path (spike / bounded / architectural) and phase sequence, and a **Gate** line naming the note
that must exist before the first source edit (§6). An empty or unknown work type renders all
five rows and no gate.
```

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/claude_md.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/claude-md.test.mjs docs/jit-context-system.md
git commit -m "feat(core): CLAUDE.md renders the work type's phases and gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `sb-research` exits by work type; `decided` is a note status

**Files:**
- Modify: `apps/cli/infra/skills/sb-research/SKILL.md` (replace the `## Exit` section)
- Modify: `docs/notes-conventions.md:52-62` (frontmatter schema)
- Modify: `docs/jit-context-system.md` §5.2 (line ~234) and §5.7 (line ~322)

**Interfaces:**
- Consumes: the CLAUDE.md `**Work type:**` line from Task 2 (`**Work type:** <type> (<path> path) — phases: …`).

This task changes prose only, so its check is a byte budget plus greps instead of a unit test.

- [ ] **Step 1: Replace the `## Exit` section of `sb-research/SKILL.md`**

Replace everything from `## Exit` to the end of the file with:

```markdown
## Exit by work type

Read the **Work type** line in the workspace CLAUDE.md (none → architectural).

- **architectural** — the deliverable is the spec. Ask open questions one at a time
  (AskUserQuestion), then present the design in chat (scope, approach, what is out)
  and stop. On the user's explicit yes, write `NNN-decision-<slug>.md` with
  `status: decided` recording the answers and the approved design. Never write
  `decided` without that yes; never re-ask once written. Unsure it was a yes → ask.
- **bounded** — the deliverable is the root cause in a `finding` note; confirm the
  fix direction in one sentence.
- **spike** — findings only. Say up front nothing built is kept; no `sb-implement`.
- **The path ratchets up, never down.** A bugfix that needs a design change becomes
  architectural: say so and write the `decision` note first.

Then invoke `sb-implement` before the first code edit (not for a spike).
```

- [ ] **Step 2: Check the budget and content**

Run: `wc -c apps/cli/infra/skills/sb-research/SKILL.md && grep -c "status: decided" apps/cli/infra/skills/sb-research/SKILL.md`
Expected: ≤ 2500 bytes, and a count ≥ 1. If the file is over budget, tighten the new section's wording. Do not cut the scope or delegation bullets above it.

- [ ] **Step 3: Update `docs/notes-conventions.md`**

In the frontmatter schema block, change the status line to:

```yaml
status: open | decided | superseded | graduated   # supersede, don't delete — attempts especially
```

Directly after the closing fence of that block, add:

```markdown
`decided` is the approved state of a `decision` note; the JIT phase gate and the ICM stage
gate both read it. Only write it after the user has approved in their own words.
```

- [ ] **Step 4: Update `docs/jit-context-system.md`**

In §5.2, where `sb-research` is described, add one sentence: "`sb-research` ends by work type: architectural work ends in a `decision` note with `status: decided` written only on the user's explicit approval, bounded work in a `finding` naming the root cause, a spike in findings only."

In §5.7, where note statuses are listed, add `decided` beside `open`/`superseded`. Say that `openDecisions()` keeps decided notes, so `sandbox notes context` re-injects the approved spec every session.

Run `grep -n "status" docs/jit-context-system.md | sed -n 1,40p` and make every status enumeration in the doc include `decided`.

- [ ] **Step 5: Run the suite**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS. No code changed, but `workspace_skills` hashes the entry skills, so this proves nothing pins the old text.

- [ ] **Step 6: Commit, then open PR 1**

```bash
git add apps/cli/infra/skills/sb-research/SKILL.md docs/notes-conventions.md docs/jit-context-system.md
git commit -m "feat(skills): sb-research ends in the work type's exit artifact

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/work-type-phases
```

Open PR 1 titled "Work type drives the JIT phases (render + skill)". The body cites the spec's §5 rollout item 1 and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. If the repo uses changesets (`ls .changeset`), add one the same way `98c1749` did.

---

# Part 2 — the phase gate (PR 2)

`git checkout -b feat/work-type-phase-gate` from `feat/work-type-phases`.

### Task 4: The manifest carries `phase_gate`, from init and from `skills sync`

**Files:**
- Modify: `packages/sandbox-core/standards.ts:600-620` (`buildStandardsManifest`)
- Modify: `packages/sandbox-core/workspace_init.ts:843` (call site)
- Modify: `packages/sandbox-core/workspace_skills.ts:242-280` (`resolveWorkspaceActive`, `resolveWorkspaceManifest`)
- Test: `packages/sandbox-core/standards-check.test.mjs`, `packages/sandbox-core/workspace-skills-manifest.test.mjs`

**Interfaces:**
- Consumes: `planFor`, `type PhaseGate` from Task 1.
- Produces:
  - `buildStandardsManifest(active: string[], modules: Record<string, Record<string, any>>, phaseGate: PhaseGate | null = null): Record<string, any>`. It adds a `phase_gate: {note, status?}` key only when `phaseGate` is non-null.
  - `resolveWorkspaceActive(workspace)` now returns `{ active, modules, workType: string } | null`.
  - `.sandbox/standards.json` → `"phase_gate": { "note": "decision", "status": "decided" }` (Task 5 reads this).

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-core/standards-check.test.mjs`, and add `buildStandardsManifest` to its import from `./dist/standards.js`:

```js
test("the manifest compiles the phase gate, and omits it when there is none", () => {
  const modules = { ui: { summary: "ui", applies_to: ["**/*.tsx"] } };
  const gated = buildStandardsManifest(["ui"], modules, { note: "decision", status: "decided" });
  assert.deepEqual(gated.phase_gate, { note: "decision", status: "decided" });
  assert.ok(!("phase_gate" in buildStandardsManifest(["ui"], modules, null)));
  assert.ok(!("phase_gate" in buildStandardsManifest(["ui"], modules)));
});
```

Append to `packages/sandbox-core/workspace-skills-manifest.test.mjs`, and add `resolveWorkspaceManifest` to its import:

```js
// `sandbox skills sync`/`check` rebuild the manifest without init's args; a
// gate that only init compiles would be stripped by the next sync.
test("the re-resolved manifest carries the work type's phase gate", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-manifest-"));
  try {
    const resolved = { active: [], modules: {}, workType: " Feature " };
    assert.deepEqual(resolveWorkspaceManifest(ws, resolved).phase_gate, {
      note: "decision",
      status: "decided",
    });
    const refactor = resolveWorkspaceManifest(ws, { ...resolved, workType: "refactor" });
    assert.ok(!("phase_gate" in refactor));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test standards-check.test.mjs workspace-skills-manifest.test.mjs`
Expected: FAIL. `phase_gate` is undefined.

- [ ] **Step 3: Implement `buildStandardsManifest`**

In `standards.ts`, add `import type { PhaseGate } from "./workspace_prompts.js";`. Add the third parameter `phaseGate: PhaseGate | null = null` and replace the `return { … }` with:

```ts
  const manifest: Record<string, any> = {
    generated_by: "sandbox init-workspace",
    universal: active.filter((key) => universal.includes(key)),
    domains,
  };
  // Omitted rather than null so a workspace with no gate keeps a byte-identical
  // manifest and `sandbox skills check` does not flag it stale.
  if (phaseGate) {
    manifest["phase_gate"] = { ...phaseGate };
  }
  return manifest;
```

Extend the doc comment with: "plus `phase_gate` (the work type's pre-implementation gate, `gate.ts`) when the plan has one".

- [ ] **Step 4: Wire init and sync**

`workspace_init.ts:843`:

```ts
    writeStandardsManifest(
      workspaceRoot,
      buildStandardsManifest(active, modules, planFor(inputs["work_type"] ?? "").gate),
    );
```

`workspace_skills.ts`: add `planFor` to the existing `./workspace_prompts.js` import. In `resolveWorkspaceActive`, change the return type to `{ active: string[]; modules: Record<string, Record<string, any>>; workType: string } | null` and the final `return` to:

```ts
  // ponytail: reads workspace.yml only — a work type passed solely as an
  // init-workspace flag or env var is not persisted, so sync falls back to
  // no gate. Persist it in init if that turns out to matter.
  return { active, modules, workType: String(workspaceConfig["work_type"] ?? "") };
```

In `resolveWorkspaceManifest`:

```ts
  return buildStandardsManifest(resolved.active, resolved.modules, planFor(resolved.workType).gate);
```

Run `grep -rn "resolveWorkspaceActive\|resolveWorkspaceManifest" packages apps --include=*.ts | grep -v dist/` and confirm that no caller builds the `resolved` object by hand; the new field would be missing there. Check `apps/mcp/tools.ts` and `apps/cli/src/commands/skills.ts` specifically.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS. Then `cd ../.. && npm run build --workspaces --if-present` (or the repo's root build) to catch type errors in `apps/`.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/standards.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/workspace_skills.ts packages/sandbox-core/standards-check.test.mjs packages/sandbox-core/workspace-skills-manifest.test.mjs
git commit -m "feat(core): compile the work type's phase gate into standards.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The gate denies source edits until the note exists

**Files:**
- Modify: `packages/sandbox-core/gate.ts` (new helpers after `_sorted`; one step in `decide()` after `relPath` is computed; module doc comment)
- Modify: `docs/jit-context-system.md` §6 (line ~376)
- Test: `packages/sandbox-core/gate.test.mjs`

**Interfaces:**
- Consumes: manifest key `phase_gate: { note: string, status?: string }` from Task 4.
- Produces: `decide()` keeps its signature `(workspaceStart: string, sessionId: string, filePath: string) => string | null`. The new deny text starts with `Phase gate:`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-core/gate.test.mjs`, and change its import to `import { decide, findWorkspaceRoot } from "./dist/gate.js";`:

```js
const DECIDED = { note: "decision", status: "decided" };

function withGatedWorkspace(phaseGate, fn, { notesDir = true } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-")));
  try {
    fs.mkdirSync(path.join(ws, ".sandbox"), { recursive: true });
    if (notesDir) fs.mkdirSync(path.join(ws, ".sandbox", "notes"));
    const manifest = { generated_by: "test", universal: [], domains: {} };
    if (phaseGate !== undefined) manifest.phase_gate = phaseGate;
    fs.writeFileSync(path.join(ws, ".sandbox", "standards.json"), JSON.stringify(manifest));
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function note(ws, name, status, eol = "\n") {
  const type = name.split("-")[1];
  const text = ["---", `type: ${type}`, `status: ${status}`, "---", "", "body", ""].join(eol);
  fs.writeFileSync(path.join(ws, ".sandbox", "notes", name), text);
}

const src = (ws) => path.join(ws, "repo", "src", "a.ts");

test("phase gate: no decision note denies, repeatedly, and writes no state", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    for (let i = 0; i < 2; i++) {
      const reason = decide(ws, "s1", src(ws));
      assert.match(reason, /^Phase gate:/);
      assert.match(reason, /`decision`/);
    }
    assert.ok(!fs.existsSync(path.join(ws, ".sandbox", ".gate")));
  });
});

test("phase gate: an open decision note still denies", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", "open");
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
  });
});

test("phase gate: a decided note falls through to the standards gate", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", "decided");
    assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `sb-implement`/);
    assert.equal(decide(ws, "s1", src(ws)), null);
  });
});

test("phase gate: a superseded note is skipped, not counted", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-old.md", "superseded");
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
    note(ws, "002-decision-new.md", "decided");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

test("phase gate: edits under .sandbox/ are never gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const target = path.join(ws, ".sandbox", "notes", "002-decision-y.md");
    assert.doesNotMatch(decide(ws, "s1", target) ?? "", /Phase gate/);
  });
});

test("phase gate: no phase_gate key, or null, behaves as today", () => {
  for (const gate of [undefined, null]) {
    withGatedWorkspace(gate, (ws) => {
      assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `sb-implement`/);
    });
  }
});

test("phase gate: a finding gate accepts any live finding note", () => {
  withGatedWorkspace({ note: "finding" }, (ws) => {
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:.*`finding`/s);
    note(ws, "001-finding-root-cause.md", "open");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

// Review Focus 2: ENOENT is "no notes yet", not "unreadable".
test("phase gate: a missing notes dir still denies", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
  }, { notesDir: false });
});

// Review Focus 3.
test("phase gate: a quoted status with CRLF line endings satisfies the gate", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", '"decided"', "\r\n");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

// Review Focus 4.
test("phase gate: a path outside the workspace is not gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const outside = path.join(path.dirname(ws), "elsewhere", "a.ts");
    assert.doesNotMatch(decide(ws, "s1", outside) ?? "", /Phase gate/);
  });
});

test("phase gate: a note with no frontmatter fails open", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    fs.writeFileSync(path.join(ws, ".sandbox", "notes", "001-decision-x.md"), "no frontmatter\n");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test gate.test.mjs`
Expected: FAIL. The first phase-gate test gets the standards text instead of `Phase gate:`.

- [ ] **Step 3: Implement the helpers**

In `gate.ts`, after `_sorted`, add:

```ts
// ---------------------------------------------------------------------------
// Phase gate (docs/jit-context-system.md §6) — deny-until, no state.
// ---------------------------------------------------------------------------

/**
 * The frontmatter `status:` of a note: the value, null when there is no
 * status line, or undefined when there is no `---` block (unparseable — the
 * caller fails open). A regex, not YAML: this module stays builtins-only.
 */
function _noteStatus(text: string): string | null | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) {
    return undefined;
  }
  const status = /^status:\s*["']?([^\s"'#]+)/m.exec(block[1]);
  return status ? status[1].toLowerCase() : null;
}

/** True when a live note satisfies *gate*, or when the check cannot be made (fail-open). */
function _phaseGateSatisfied(workspace: string, gate: Record<string, any>): boolean {
  const note = String(gate["note"] ?? "");
  if (!/^[a-z]+$/.test(note)) {
    return true;
  }
  const want = gate["status"] ? String(gate["status"]).toLowerCase() : null;
  const dir = path.join(workspace, ".sandbox", "notes");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (exc) {
    // No notes dir yet means no notes — deny. Anything else is unreadable — allow.
    return (exc as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const pattern = new RegExp(`^\\d{3}-${note}-.+\\.md$`);
  for (const name of names) {
    if (!pattern.test(name)) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return true;
    }
    const status = _noteStatus(text);
    if (status === undefined) {
      return true;
    }
    if (status === "superseded" || status === "graduated") {
      continue;
    }
    if (want === null || status === want) {
      return true;
    }
  }
  return false;
}

function _phaseGateText(gate: Record<string, any>): string {
  const note = String(gate["note"]);
  if (gate["status"]) {
    const status = String(gate["status"]);
    return (
      `Phase gate: no \`${note}\` note in \`.sandbox/notes/\` has \`status: ${status}\`, so ` +
      "source edits wait for an approved design. Invoke `sb-research`, present the design to " +
      `the user, and when they approve write \`NNN-${note}-<slug>.md\` with ` +
      `\`status: ${status}\` recording what was approved. Then retry this edit. Edits under ` +
      "`.sandbox/` are not gated."
    );
  }
  return (
    `Phase gate: no \`${note}\` note in \`.sandbox/notes/\` names the root cause yet. Invoke ` +
    `\`sb-research\`, reproduce the problem, and write \`NNN-${note}-<slug>.md\` stating the ` +
    "root cause. Then retry this edit. Edits under `.sandbox/` are not gated."
  );
}
```

- [ ] **Step 4: Add the step to `decide()`**

Directly after `const relPath = filePath ? path.relative(workspace, filePath) : "";`, add:

```ts
  // 2a. Phase gate (§6): deny-until the work type's note exists. Before the
  // standards logic, records nothing, and never gates `.sandbox/` — the note
  // that satisfies it must be writable.
  const phaseGate = manifest["phase_gate"];
  if (
    _isDict(phaseGate) &&
    relPath &&
    !relPath.startsWith("..") &&
    !path.isAbsolute(relPath) &&
    !relPath.startsWith(".sandbox" + path.sep) &&
    !_phaseGateSatisfied(workspace, phaseGate)
  ) {
    return _phaseGateText(phaseGate);
  }
```

In the module doc comment at the top, after the first paragraph, add: "When the manifest carries `phase_gate` (the work type's pre-implementation gate), source edits are denied *until* a matching note exists in `.sandbox/notes/`. That deny repeats and records no state, because it is an approval gate, not a delivery gate."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS, all 13 gate tests (2 old + 11 new).

- [ ] **Step 6: Latency check**

Build the CLI (the root build that emits `apps/cli/dist/lib/gate.js`; see `apps/cli/package.json` scripts). Then, from a temp workspace made the same way as the tests (manifest with `phase_gate`, 50 dummy `NNN-finding-*.md` notes), run:

```bash
time (echo '{"session_id":"s1","cwd":"'"$WS"'","tool_input":{"file_path":"'"$WS"'/repo/a.ts"}}' | node apps/cli/dist/lib/gate.js)
```

Expected: a deny JSON on stdout and wall time well under 200ms. Record the number in the commit body.

- [ ] **Step 7: Update `docs/jit-context-system.md` §6**

In the decision table, insert this step between 1 and 2 and renumber the rest:

```markdown
2. **Phase gate.** If the manifest carries `phase_gate` (compiled from the work type,
   `workspace_prompts.ts::WORK_TYPE_PHASES`) and the edited path is inside the workspace and
   not under `.sandbox/`: scan `.sandbox/notes/NNN-<note>-*.md`. A note satisfies the gate when
   its `status` is not `superseded`/`graduated` and, if the gate names a status (`decided` for
   `feature`), equals it. No satisfying note → deny with the phase-gate text.
```

After the "Fail-open throughout." paragraph, add:

```markdown
**Two deliberate departures for the phase gate.** It is *deny-until*, not deny-once: it is an
approval gate, and a once-only deny would mean "acknowledge you skipped approval, then
proceed". The note is the only key. And it keeps *no state* in `.sandbox/.gate/`. A missing
notes directory counts as "no notes" and denies; every other read failure, and a note with no
frontmatter block, fails open. Status is read with a regex, not YAML, to keep the module
builtins-only.
```

In the "The manifest is a compilation" paragraph, add `phase_gate` to the list of what `.sandbox/standards.json` holds, and say that `sandbox skills sync` recompiles it from `workspace.yml`'s `work_type`.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-core/gate.ts packages/sandbox-core/gate.test.mjs docs/jit-context-system.md
git commit -m "feat(gate): phase gate denies source edits until the work type's note exists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Known issues, end-to-end check, PR 2

**Files:**
- Modify: `docs/known-issues.md` (the two entries at ~389 and ~407; see "Before you start")

- [ ] **Step 1: Add the fix pointers**

In "Answers Given in Chat Are Not Persisted, So Later Phases Re-Ask", under the `**Likely fix:**` paragraph, add:

```markdown
**Fix:** `docs/superpowers/specs/2026-09-27-work-type-phases.md`. `sb-research` now ends a
`feature` in a `decision` note with `status: decided` recording the answers, `sandbox notes
context` re-injects it every session, and the phase gate blocks source edits until it exists.
Confirm with a jit-ws2 rerun before closing.
```

In "Generated CLAUDE.md Task Title Competes With the Starting Prompt", add:

```markdown
**Fix (partial):** `docs/superpowers/specs/2026-09-27-work-type-phases.md`. The seeded handoff
and CLAUDE.md now name the phase and artifact to start with, which is what the run-2 model
asked about. The task-title-vs-prompt conflict itself is unchanged; this entry stays open.
```

Leave both `**Status:** Open`.

- [ ] **Step 2: End-to-end on a real workspace**

Pick a throwaway workspace (the trim plan used `~/features/test`). Set `work_type: feature` in its `.sandbox/workspace.yml`, then run `sandbox init-workspace` from inside it. Verify:

```bash
grep -A1 "Work type" CLAUDE.md                               # feature (architectural path) … + Gate line
jq .phase_gate .sandbox/standards.json                        # {"note":"decision","status":"decided"}
sandbox skills check                                          # no "stale: .sandbox/standards.json"
echo '{"session_id":"e2e","cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/<repo>/x.ts"}}' | sandbox hooks gate   # Phase gate deny
```

Then write `.sandbox/notes/0NN-decision-e2e.md` with `status: decided` and rerun the gate command. Expected: the standards-gate text, not the phase gate. Then set `work_type: refactor`, run `sandbox skills sync`, and confirm `jq .phase_gate` prints `null` and CLAUDE.md (after `init-workspace`) has no research row. Delete the e2e note afterwards.

- [ ] **Step 3: Full suite**

Run: `cd packages/sandbox-core && npm test`, then the repo root test command.
Expected: PASS.

- [ ] **Step 4: Commit and open PR 2**

```bash
git add docs/known-issues.md
git commit -m "docs: point the chat-answers and task-title issues at the work-type spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/work-type-phase-gate
```

Open PR 2 titled "Phase gate: no source edit until the work type's note exists", based on `feat/work-type-phases` (or on `main` if PR 1 has merged). The body cites spec §5 rollout item 2, lists the seven deviations above, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Mark done**

Once both PRs merge, add `**Status: done**` under this plan's title and change the spec's `**Status:** proposed` to `**Status:** done`. The rerun of the jit-ws2 protocol (spec §5) is the user's call and is not part of this plan.

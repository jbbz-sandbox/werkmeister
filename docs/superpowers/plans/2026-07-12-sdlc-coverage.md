# SDLC Coverage (sb-review + sb-pr) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two missing SDLC phase-entry skills — `sb-review` (code-review phase) and `sb-pr` (PR/finishing phase) — and wire them into the generated workspace CLAUDE.md phase table.

**Architecture:** Two new hand-authored SKILL.md files in `infra/skills/` (picked up automatically by the glob-based projection in `apps/cli/src/lib/workspace_skills.ts`), plus a text-only edit to the "Standards routing" template in `apps/cli/src/lib/claude_md.ts`. No generator, frontmatter-schema, or notes-schema changes — spec `docs/superpowers/specs/2026-07-12-sdlc-coverage-design.md` §6 lists what must NOT change.

**Tech Stack:** Markdown skill files; Node 20+ (`cli` package); vitest via `npx vitest run` from the repo root.

## Global Constraints

- Branch: `multi-feature` (permanent; never merges to `main`).
- Commits: conventional commits, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Test command (always from repo root): `npx vitest run apps/cli/src/lib/__tests__/<file> -q`.
- Do NOT touch: `apps/cli/src/lib/skill_gen.ts`, `docs/standards/*` frontmatter (`phase:` values), `apps/cli/src/lib/agent_gen.ts`, `infra/config/services.yaml`, notes types.
- Skill files copy the voice and structure of `infra/skills/sb-implement/SKILL.md` (frontmatter `name` + quoted `description`, numbered steps, `## Capture as you go` section where applicable, trailing no-routing-block fallback paragraph).

---

### Task 1: sb-review entry skill

**Files:**
- Create: `infra/skills/sb-review/SKILL.md`

**Interfaces:**
- Consumes: nothing from other tasks. References the generated `tr-*-standard` skills, `.sandbox/notes/`, `superpowers:requesting-code-review`.
- Produces: the skill name `sb-review`, invoked by Task 2's sb-pr step 2 and named in Task 3's phase table.

- [ ] **Step 1: Create the skill file**

Write `infra/skills/sb-review/SKILL.md` with exactly this content:

````markdown
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
   `tr-*-standard` skill. The inline anti-pattern one-liners in each standard
   are your review checklist; open a linked `ap-*.md` war story only when you
   suspect the diff hits it — not preemptively.
3. **Load `sb-comments-standard`** — the comment rubric applies to every review.
4. **Read the workspace notes** in `.sandbox/notes/`: every `decision` and
   `contract` note (skip `status: superseded`). A diff that violates a
   `decision` note is itself a review finding — cite the note in the finding.
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

`sandbox down` will offer to graduate it into `docs/standards/`.

If the workspace `CLAUDE.md` has no "Standards routing" block (not a
sandbox-initialized workspace), load `sb-comments-standard` only and review
against it.
````

- [ ] **Step 2: Verify projection picks it up**

Run from the repo root:

```bash
node -c "from cli.lib.workspace_skills import render_workspace_skills; r = render_workspace_skills(); assert 'sb-review' in r, sorted(r); print(sorted(r))"
```

Expected: prints the skill list including `sb-review`; no AssertionError.

- [ ] **Step 3: Run the existing skills test suite (regression guard)**

```bash
npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -q
```

Expected: all pass (fixture-based; the new directory must not break them).

- [ ] **Step 4: Commit**

```bash
git add infra/skills/sb-review/SKILL.md
git commit -m "feat(skills): sb-review code-review phase entry skill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: sb-pr entry skill + workspace_skills docstring counts

**Files:**
- Create: `infra/skills/sb-pr/SKILL.md`
- Modify: `apps/cli/src/lib/workspace_skills.ts:5-17` (docstring only)

**Interfaces:**
- Consumes: the skill name `sb-review` from Task 1 (step 2 of the skill invokes it).
- Produces: the skill name `sb-pr`, named in Task 3's phase table.

- [ ] **Step 1: Create the skill file**

Write `infra/skills/sb-pr/SKILL.md` with exactly this content:

````markdown
---
name: sb-pr
description: "Begin the PR/finishing phase in a Sandbox sandbox workspace. Use when implementation and tests are done and a pull request is about to be created — the user says 'create a PR', 'ship it', 'open a pull request', or 'finish this branch'."
---

# sb-pr — enter the PR/finishing phase

Run these steps in order. Steps 1 and 2 are gates — a failure stops the PR.

1. **Pre-PR gate — local CI checks.** Run the repo's lint, tests, type checks,
   and build. Any failure → fix it first. Never create a PR on failing local
   checks.
2. **Self-review.** Invoke `sb-review` on the branch diff (vs the base branch)
   and address its findings before continuing.
3. **PR conventions:**
   - **Title:** `<type>(<optional scope>): <JIRA-ID> <short description>` —
     conventional-commit types (`feat`, `fix`, `refactor`, `chore`, `docs`,
     `test`, `ci`, `perf`); scope optional, use it when targeting a specific
     app/package.
     Example: `feat(product-api): PROJ-1125 Add trustmap field to Product type`
   - **Body:**

     ```markdown
     ## Summary
     <1-3 bullet points covering what and why>

     ## Test plan
     <checklist of verification steps>

     Refs: <JIRA-ID>

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```

   - **Jira:** transition the ticket named in the title to **In Development**
     (use your configured Jira tooling; connection specifics live in your
     personal config, not this skill).
4. **Branch mechanics:** use `superpowers:finishing-a-development-branch` if
   installed; if not, say so once and create the PR with `gh pr create`.
5. **Checkpoint:** after the PR exists, suggest `sb-handoff` so the PR state
   survives into the next session.
````

- [ ] **Step 2: Update the workspace_skills.ts docstring counts**

In `apps/cli/src/lib/workspace_skills.ts`, two edits in the module
docstring:

Replace:

```
The nine tr-* skills are projected into each workspace's `.claude/skills/`
```

with:

```
The eleven tr-* skills are projected into each workspace's `.claude/skills/`
```

Replace:

```
- the four hand-authored entry skills (sb-implement, sb-research, sb-test,
  sb-handoff) are read verbatim from infra/skills/.
```

with:

```
- the six hand-authored entry skills (sb-implement, sb-research, sb-test,
  sb-handoff, sb-review, sb-pr) are read verbatim from infra/skills/.
```

- [ ] **Step 3: Verify projection picks both new skills up**

```bash
node -c "from cli.lib.workspace_skills import render_workspace_skills; r = render_workspace_skills(); assert {'sb-review', 'sb-pr'} <= set(r), sorted(r); print(sorted(r))"
```

Expected: prints the skill list including both `sb-pr` and `sb-review`.

- [ ] **Step 4: Run the skills test suite (regression guard)**

```bash
npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add infra/skills/sb-pr/SKILL.md apps/cli/src/lib/workspace_skills.ts
git commit -m "feat(skills): sb-pr PR/finishing phase entry skill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Phase table in generated workspace CLAUDE.md

**Files:**
- Modify: `apps/cli/src/lib/claude_md.ts:159-175` (the
  `build_standards_routing_section` template: "Phase entry" paragraph and
  "By phase" table)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts` (extend
  `test_routing_section_renders_active_and_not_active`)

**Interfaces:**
- Consumes: skill names `sb-review` (Task 1) and `sb-pr` (Task 2) — text
  references only, no imports.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Write the failing assertions**

In `apps/cli/src/lib/__tests__/standards.test.ts`, at the end of
`test_routing_section_renders_active_and_not_active` (after the
`"| graphql | ..." not in section` assertion), add:

```node
    # SDLC coverage (2026-07-12 spec §5): review row has its entry skill,
    # and the PR phase exists.
    assert "| review | `sb-review` | the standards covering files in the diff |" in section
    assert (
        "| PR / finishing | `sb-pr` | nothing — runs the pre-PR gate, then `sb-review` |"
        in section
    )
    assert "invoke `sb-pr` to finish the branch and create the PR" in section
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run apps/cli/src/lib/__tests__/standards.test.ts::test_routing_section_renders_active_and_not_active -q
```

Expected: FAIL on the first new assertion (`| review | \`sb-review\` |` not in section).

- [ ] **Step 3: Update the template in claude_md.ts**

In `build_standards_routing_section` in
`apps/cli/src/lib/claude_md.ts`, replace this part of the returned
f-string:

```node
**Phase entry:** invoke `sb-research` when exploring or planning; invoke `sb-implement` \
BEFORE your first code edit — it loads the universal base (`ponytail` + \
`sb-comments-standard`) and the Active rows matching the files you edit; invoke \
`sb-test` to run or write tests.
```

with:

```node
**Phase entry:** invoke `sb-research` when exploring or planning; invoke `sb-implement` \
BEFORE your first code edit — it loads the universal base (`ponytail` + \
`sb-comments-standard`) and the Active rows matching the files you edit; invoke \
`sb-test` to run or write tests; invoke `sb-review` BEFORE reviewing any diff or PR; \
invoke `sb-pr` to finish the branch and create the PR.
```

and replace the "By phase" table:

```node
| Phase | Entry skill | Load |
|-------|-------------|------|
| research / planning | `sb-research` | nothing — spawns the read-only `sb-researcher` agent |
| implementing | `sb-implement` | universal base + rows matching the files you edit |
| testing | `sb-test` | nothing — spawns the matching `sb-tester-<archetype>` agent(s) |
| review | — | the standards covering files in the diff |
```

with:

```node
| Phase | Entry skill | Load |
|-------|-------------|------|
| research / planning | `sb-research` | nothing — spawns the read-only `sb-researcher` agent |
| implementing | `sb-implement` | universal base + rows matching the files you edit |
| testing | `sb-test` | nothing — spawns the matching `sb-tester-<archetype>` agent(s) |
| review | `sb-review` | the standards covering files in the diff |
| PR / finishing | `sb-pr` | nothing — runs the pre-PR gate, then `sb-review` |
```

Also update the function's docstring sentence naming the entry skills:

Replace:

```
    `sb-test` are the phase-entry skills that read this table (spec §5.6 — the
```

with:

```
    `sb-test`/`sb-review` are the phase-entry skills that read this table (spec §5.6 — the
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -q
```

Expected: all pass.

- [ ] **Step 5: Full CLI test suite (pre-commit regression guard)**

```bash
npx vitest run apps/cli -q
```

Expected: all pass (the phase-table text is not asserted anywhere else; the
characterization tests in `claude_md_characterization.test.ts` cover other
sections).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/lib/claude_md.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(sandbox-cli): sb-review + sb-pr rows in workspace phase table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

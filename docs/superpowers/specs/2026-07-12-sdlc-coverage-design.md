# SDLC Coverage — sb-review + sb-pr Entry Skills

> **Status:** Approved design, 2026-07-12.
> **Scope:** second of four sub-projects extending the JIT context system
> (jit-standards-loading-spec.md). Consumes the content model from
> 2026-07-12-standards-content-model-design.md. Later sub-projects:
> creation-time tailoring, authoring/capture pipeline.
> **Affects:** `infra/skills/` (two new skills), `apps/cli/src/lib/claude_md.ts`,
> `apps/cli/src/lib/workspace_skills.ts` (docstring), tests.

## 1. Problem

The entry-skill layer covers research → implement → test → handoff, but the
standards *content* already declares review-phase relevance — every module in
`docs/standards/` carries `phase: [implement, review]`, and `skill_gen.ts`
renders a REVIEWING trigger verb — yet nothing consumes `review` at phase
entry. The generated workspace CLAUDE.md "By phase" table even ships a
`| review | — |` row with no skill (`claude_md.ts`). PR creation is similarly
uncovered: the pre-PR checklist, title/body conventions, and
review-before-PR rule live only in personal CLAUDE.md, unenforced and
invisible to other workspace users.

## 2. Decisions (settled in brainstorming — do not re-litigate)

1. **Two new entry skills: `sb-review` and `sb-pr`.** No `sb-design` — the
   design/brainstorm phase stays with superpowers:brainstorming and
   sb-research's existing notes/spec loading.
2. **Delegate pattern, like ponytail in sb-implement.** The tr-* skill loads
   TR context, then points at the process skill (superpowers or the user's
   PR-review skills) with the established fallback: "if it isn't installed,
   say so once and continue."
3. **Review loads the same tier-1 STANDARD.md as implement.** No generated
   review-checklist artifact, no `## Review checklist` authoring convention.
   The content model's inline anti-pattern one-liners ARE the checklist;
   `ap-*.md` war stories open on demand.
4. **PR conventions live inline in sb-pr.** No `pr.md` standards module, no
   new `phase:` frontmatter value, no `skill_gen.ts` change.
5. **sb-review is direction-agnostic:** one skill for both self-review of
   your own branch (pre-PR) and reviewing someone else's PR — the TR context
   load is identical; only the delegated process differs.

## 3. sb-review

New hand-authored skill at `infra/skills/sb-review/SKILL.md`, same shape as
sb-implement (frontmatter name + description, numbered steps, capture
section).

**Description (the trigger gate):** "Begin the code-review phase in a
Sandbox sandbox workspace. Use BEFORE reviewing any diff, branch, or
PR — self-reviewing your own branch before creating a PR, or reviewing
someone else's PR."

**Steps:**

1. Read the "Standards routing" block in the workspace `CLAUDE.md`.
2. Map the diff's files against each Active row's "Loads on" globs; load the
   matching `tr-*-standard` skills. The inline anti-pattern one-liners are
   the review checklist. Open an `ap-*.md` war story only when a hit is
   suspected (tier-2, on demand).
3. Load `sb-comments-standard` — the comment rubric applies to every review.
4. Read `.sandbox/notes/`: every `decision` and `contract` note (skip
   `status: superseded`). A diff that violates a decision note is itself a
   review finding.
5. Delegate the process:
   - self-review of your own branch → `superpowers:requesting-code-review`
   - someone else's PR → your PR-review skill
   - neither installed → say so once, review directly against the loaded
     checklists.
6. **Capture (the sub-project-4 seam):** when a review nit reveals a pattern
   worth codifying that no standard covers, write a `decision` note to
   `.sandbox/notes/` at that moment (`phase: review`). `sandbox down`'s
   existing graduation prompt is the path from note → `docs/standards/`. No
   new note type.

## 4. sb-pr

New hand-authored skill at `infra/skills/sb-pr/SKILL.md`.

**Description:** "Begin the PR/finishing phase in a Sandbox sandbox
workspace. Use when implementation and tests are done and a PR is about to
be created — 'create a PR', 'ship it', 'finish this branch'."

**Steps:**

1. **Pre-PR gate:** run the local CI checks (lint, tests, type checks,
   build). Any failure → fix first; never create a PR on failing checks.
2. **Self-review:** invoke `sb-review` on the branch diff. (The
   review-before-PR rule becomes enforced sequencing, not a reminder.)
3. **Conventions (inline):**
   - Title: `<type>(<optional scope>): <JIRA-ID> <short description>`,
     conventional-commit types.
   - Body: Summary (1–3 bullets) / Test plan (checklist) / `Refs: <JIRA-ID>`
     / generated-with footer.
   - Transition the Jira ticket to **In Development**. Worded generically —
     MCP/cloud-ID/transition-ID specifics stay in personal config, since this
     skill projects to every workspace user.
4. Delegate branch mechanics to `superpowers:finishing-a-development-branch`
   (same not-installed fallback).
5. After the PR exists, suggest `sb-handoff` to checkpoint session state.

## 5. Integration changes

- `apps/cli/src/lib/claude_md.ts`:
  - "Phase entry" paragraph gains sb-review and sb-pr sentences.
  - "By phase" table: `review` row's `—` becomes `sb-review` (load: "the
    standards covering files in the diff"); new
    `| PR / finishing | sb-pr | nothing — runs the pre-PR gate, then sb-review |`
    row.
- `apps/cli/src/lib/workspace_skills.ts`: docstring "the four hand-authored entry
  skills" → six. Projection itself is glob-based
  (`source.glob("*/SKILL.md")`) — no code change; `sandbox skills check|sync`
  picks the new skills up automatically.

## 6. Explicitly unchanged

- No new `phase:` frontmatter values; `review` finally gets its consumer.
- No `skill_gen.ts` change (REVIEWING verb already renders; nothing consumes
  a `pr` phase).
- No notes-schema change, no new agents (`agent_gen.ts` untouched), no
  `services.yaml`/routing change, no generated review-checklist artifact.

## 7. Error handling

Both skills inherit the established degradation rules: missing Standards
routing block → universal base only (sb-review: `sb-comments-standard`;
sb-pr: run the gate + conventions without standards context); missing/empty
notes directory → continue; process skill not installed → say so once and
continue.

## 8. Testing

- `claude_md.ts` rendering tests (existing test module) updated for the new
  paragraph and table rows — TDD: failing assertion first.
- No new test surface for the skills themselves: hand-authored SKILL.md files
  are content. The projection/staleness tests (`workspace_skills.test.ts`)
  are fixture-based — they build their own `infra/skills/` in tmp dirs — so
  the new directories break nothing and need no test change. End-to-end
  verification is `sandbox skills sync` in a workspace showing the two new
  skills.

## 9. Out of scope

- Sub-project 3 (creation-time tailoring) and 4 (authoring pipeline) — this
  spec only leaves them the `phase: review` decision-note capture seam.
- Any change to `docs/standards/` content (sub-project 1's plan owns that).
- A `sb-design` phase skill (rejected in brainstorming).

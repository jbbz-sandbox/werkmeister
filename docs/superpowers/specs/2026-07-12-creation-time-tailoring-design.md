# Creation-Time Tailoring — work_type Field + First-Phase Seeding

> **Status:** Approved design, 2026-07-12.
> **Scope:** third of four sub-projects extending the JIT context system
> (jit-standards-loading-spec.md). Follows 2026-07-12-sdlc-coverage-design.md
> (sb-review/sb-pr, executed) and consumes the phase-skill set it completed.
> Remaining sub-project: authoring/capture pipeline (#4).
> **Affects:** `apps/cli/src/commands/init_workspace.ts` (field, mapping, seeding),
> `cli/main.ts` (argparse), `apps/cli/src/commands/workspace.ts` (flag forwarding),
> tests. Nothing else.

## 1. Problem

Workspace creation collects *what* to build (feature, services, task,
starting prompt) but not *what kind of work* it is. Every workspace's first
session starts identically: the seeded starting-prompt handoff note
(`_seed_starting_prompt_handoff`) hardcodes `phase: research` and only exists
when a starting prompt was given. A bugfix, a spike, and a refactor all get
the same — or no — first-phase direction. Domain tailoring already derives
from services (archetypes → standards routing); the nature of the work is the
one creation-time signal nothing derives.

## 2. Decisions (settled in brainstorming — do not re-litigate)

1. **One new field: `work_type`** — enum
   `feature | bugfix | refactor | spike | incident`. Rejected alternatives:
   an explicit starting-phase field, standards pre-selection in the form,
   per-type `refine_instruction` variants, rendering work type into
   CLAUDE.md's Current Task section.
2. **Default `feature`, always recorded** in workspace.yml. No
   missing-work-type branch exists downstream.
3. **Single downstream effect: seed the first-phase entry.** Mapping:

   | work_type | note `phase:` | invoke first |
   |-----------|---------------|--------------|
   | feature   | research      | sb-research  |
   | bugfix    | research      | sb-research (reproduce + locate root cause before changing code) |
   | refactor  | implement     | sb-implement |
   | spike     | research      | sb-research  |
   | incident  | research      | sb-research  |

4. **Note content = phase + one entry-skill sentence.** No per-type
   playbooks — the entry skills carry the how.
5. **Seed even without a starting prompt:** a minimal handoff note carrying
   just the work-type line, so every first session gets phase direction.
6. **Mapping lives as a code constant in `init_workspace.ts`**, next to
   `_WIZARD_PROMPTS`. No config file (5 stable values, one consumer), no
   skill-side interpretation.

## 3. The field

New `PromptSpec(key="work_type")` in `_WIZARD_PROMPTS`, inserted directly
after `feature`:

- `choices_fn` returns the five static values; `default_fn` returns
  `"feature"`; `accept_empty=False` so the default stands in when the user
  enters nothing and the value is always recorded; `pattern`
  `^(feature|bugfix|refactor|spike|incident)$` backs wizard validation.
- **All form surfaces come free.** `form_schema.ts` already maps
  single-choice prompts to a string enum (dropdown) with the default
  pre-filled in formData; the node app's `buildWorkspaceArgs`
  (`apps/mcp-workspace/lib/sandbox.ts`) generically kebab-cases formData keys
  into CLI flags, so the browser form, dashboard tab, and Desktop inline form
  all submit `--work-type <value>` with zero JS/TS changes.
- Plumbing that IS needed:
  - `--work-type` argparse option on both `init-workspace` and `workspace`
    in `cli/main.ts`.
  - Resolution-tuple entry `("work_type", "SANDBOX_WORK_TYPE", "work_type")`
    in `init_workspace.ts` so CLI > env > workspace.yml resolution applies.
  - Forwarding entry `("work_type", "--work-type")` in `workspace.ts`
    `_init_workspace_flags`.
  - Persistence to `.sandbox/workspace.yml` is automatic — all resolved
    inputs persist.
- **Wart fix (required):** `_prompt_one` currently runs `_normalize_services`
  on *any* prompt with choices. For a single-select field a typo would be
  silently blanked with a misleading "Unknown services" warning. Normalize
  only when `spec.multi`; single-select input falls through to the pattern
  check, which rejects invalid values with a retry.

## 4. Seeding change

Rename `_seed_starting_prompt_handoff` →
`_seed_starting_handoff(workspace_root, starting_prompt, work_type)`:

- Constant `WORK_TYPE_PHASES: dict[str, tuple[str, str]]` maps work type →
  `(phase, entry_skill)` per the §2 table. Unknown/empty work type falls back
  to `("research", "sb-research")` — same behavior as today.
- The note's frontmatter `phase:` comes from the mapping (was hardcoded
  `research`).
- Body order: the work-type sentence first (e.g. "This workspace is a bugfix
  — invoke sb-research first to reproduce and locate the root cause before
  changing code."), then, when a starting prompt exists, the existing
  "confirm direction with the user before executing" framing plus the prompt
  text. A minimal (no-prompt) note omits the confirm-direction sentence —
  there is no task to confirm.
- Seeds whenever it runs (work_type always resolves now). The existing
  write-once gate — skip if ANY handoff note exists, superseded included —
  is unchanged and still prevents re-seeding on re-init and resurrection of
  superseded prompts.

## 5. Explicitly unchanged

- `apps/cli/src/lib/form_schema.ts` — single-choice enum support already exists.
- `apps/mcp-workspace/` — `buildWorkspaceArgs` flag mapping is generic.
- `apps/cli/src/lib/claude_md.ts` — no Current Task rendering of work type (rejected).
- `apps/cli/src/lib/standards.ts` / `standards_override` — domain tailoring already
  derives from services; work type does not touch standards resolution.
- The six tr-* entry skills, notes schema, `skill_gen.ts`, `services.yaml`.

## 6. Error handling

- Seeding failures warn and never block init (existing rule, unchanged).
- Invalid `--work-type` / env values: rejected at input time (argparse
  `choices` + wizard pattern); a bad value smuggled into workspace.yml by
  hand falls back to the research/sb-research default at seed time rather
  than erroring.
- Legacy workspaces (no `work_type` in workspace.yml) re-init fine: the
  default applies at resolution, and their existing handoff notes gate
  re-seeding anyway.

## 7. Testing (TDD — failing test first, per plan)

- `form_schema.test.ts`: work_type renders as a required string enum with
  default `feature` in formData.
- Wizard/resolution tests (`init_workspace.test.ts` area): default stands in
  on blank input; CLI flag outranks workspace.yml; `_normalize_services` no
  longer touches single-select fields (typo → retry, not silent blank).
- Seeding tests (`notes.test.ts`, where the current seed tests live): per-type
  phase + skill line; refactor seeds `phase: implement`; no-prompt minimal
  note has the work-type line and no confirm-direction sentence; write-once
  gate still holds.
- `workspace.test.ts`: `--work-type` forwards to init-workspace via
  `_init_workspace_flags`.

## 8. Out of scope

- Sub-project 4 (authoring pipeline).
- Any per-work-type standards emphasis, prompt refinement, or CLAUDE.md
  rendering (all rejected in brainstorming — revisit only with new evidence).
- Auto-invoking the mapped entry skill at SessionStart; the note directs, the
  human/agent decides.

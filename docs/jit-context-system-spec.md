# JIT Context System — Complete Specification (as-built)

> **Status:** current state as of 2026-07-18, on branch `multi-feature` (permanent, never merges to `main`).
> Includes the fixes queued in `docs/superpowers/plans/2026-07-18-jit-bug-fixes.md` (re-inject
> block ordering/wording/precedence line, generated-skill precedence footer, hooks-merge guards,
> universal ordering) — §5.1 and §5.7 describe the post-plan state; strike this note once that
> plan has landed.
> **Purpose of this document:** a single, harness-portable specification of the entire just-in-time
> context system. The per-subsystem design history lives in `docs/jit-standards-loading-spec.md`,
> `docs/jit-agents-and-tools-spec.md`, `docs/jit-notes-and-handoffs-spec.md`, and
> `docs/superpowers/specs/`; this doc consolidates what was actually built so the system can be
> re-implemented on a different coding-agent harness (§10) if Claude Code is ever swapped out.

## 1. Goals

1. **Just-in-time standards** — deliver coding standards to agents only when relevant, never as an
   always-on preamble.
2. **Token conservation** — minimal standing footprint; pay for context at the moment of use.
3. **Phase awareness** — research, implement, test, review, and PR each load different context.
4. **Domain and repo awareness** — UI standards only on UI work, and only in workspaces whose
   repos/services actually contain that domain.
5. **Cheap-model enablement** — the economic goal: with the right context delivered at the right
   moment, a less capable (cheaper) model completes work it would otherwise fail
   (measured: harness-6, Haiku 4.5, 9/9 applied with standards loaded vs 0/9 control).

## 2. Design model

Three gating axes, each wired to its natural mechanism:

| Axis | Mechanism | Resolution time |
|------|-----------|-----------------|
| **Phase** (research/implement/test/review/pr) | Phase-entry skills (`sb-implement`, …) + a compiled routing table in the workspace `CLAUDE.md` | runtime, model-invoked |
| **Domain** (ui/service/data/auth/config/testing/observability) | Generated `tr-<domain>-standard` skills; trigger = skill description + entry-skill instruction to match `applies_to` globs against files being edited | runtime, model-invoked |
| **Repo presence** | `services.yaml` archetypes → standards keys, resolved per workspace at init | init time, deterministic |

Governing principles (each anchored to a measurement in
`docs/experiments/context-management/results/`):

- **Map, not territory.** The workspace `CLAUDE.md` carries a compiled routing *table*, never
  standard bodies. Bodies live in skills and load on demand. (Harness-1: skill descriptions cost
  ~3–7 standing tokens each; bodies are fully lazy.)
- **Phase entry beats description-gating.** Model-side description matching collapses for common
  file types (harness-2: 0/16 trigger for ui/api). The deterministic chain — routing table names
  the entry skill, entry skill loads the standards — measured 15/15 preventive.
- **Prevention requires pre-generation loading.** Rules must be in context before the first code
  draft; an edit-time hook fires after drafting begins (spec §5.9).
- **Precedence is the causal compliance lever.** Rule content alone loses to conflicting task
  framing (harness-5: Haiku 0/3→3/3 with the precedence block; harness-7: enriched rule summaries
  without precedence still 0/3). Every delivery path must carry the invariant/rule/nit precedence
  framing, not just the rules.
- **Persistence must be contracted.** Agents never write durable notes spontaneously (harness-4:
  0/3 uncontracted vs 3/3 contracted). Every note-producing behavior is an explicit instruction
  with a format.
- **Subagent tool gates convert "reliably behaves" into "cannot misbehave"** (harness-3).

## 3. Content model — `docs/standards/`

Single source of truth for all standards content. Two recognized shapes (loader:
`apps/cli/src/lib/standards.ts:_iter_standard_files`):

- flat: `docs/standards/<key>.md`
- directory: `docs/standards/<domain>/STANDARD.md` (+ optional `references/*.md`)

All nine current domains use directory form: `comments`, `engineering` (the two universals),
`ui`, `service`, `data`, `auth`, `config`, `testing`, `observability`.

### 3.1 Frontmatter schema (enforced by `validate_standard_modules`)

```yaml
---
domain: ui                 # required; MUST equal directory name / file stem
summary: One-line summary. # required; feeds skill description + routing table + re-inject block
applies_to:                # required; non-empty list of globs — the diff/file gate
  - "**/*.tsx"
  - "**/components/**"
phase: [implement, review] # optional; MUST be a list if present; default [implement, review]
---
```

### 3.2 Body conventions

- Rules are concise prose + `## Don't` bullets. Anti-pattern one-liners double as the review
  checklist.
- `references/<name>.md` files (directory form only) hold war-stories/deep dives; each must be
  linked from the STANDARD.md index, and each `ap-*.md` (anti-pattern) reference must additionally
  have an inline don't-line bullet linking to it (enforced by `validate_module_references`).
  References carry a `canonical: <repo>:<path>` frontmatter pointer to the exemplar file.
- `docs/standards/repos/*.md` are per-repo quirk snippets keyed by `repo:`, referenced from
  standard bodies; they are **not** loadable standards.
- Authoring/graduation flow: review findings become `decision` notes; `sandbox notes graduate`
  scaffolds a standard entry with `TODO(graduate)` markers; the `sb-author` skill fills them; the
  validator blocks committing unfilled markers.

### 3.3 Universal standards

`UNIVERSAL_STANDARDS = ("comments", "engineering")` (`apps/cli/src/lib/standards.ts`). Tuple order is
semantic (base first). Universals: always active in every workspace, ungated by file type
(`applies_to: ["**/*"]`), never listed in any service's `standards:`, loaded at implement-phase
entry, and always included in post-compaction re-injection when anything changed.

## 4. Resolution semantics

### 4.1 Workspace activation (init time) — `resolve_active_standards`

```
services.yaml:  repos.<repo>.services  →  service.archetype  →  archetypes.<name>.standards
```

1. Candidate services = the workspace's **selected** services (declared intent) if any, else the
   union of services across the workspace's repos (fallback). Selected-wins matters for monorepos:
   econx spans ui+graphql+api, so repo-union would activate everything.
2. Union each candidate service's archetype `standards:` keys (legacy per-service `standards:`
   lists are normalized through `apps/cli/src/lib/archetypes.ts`).
3. Apply `workspace.yml` `standards_override: {add: [...], remove: [...]}`.
4. Add `UNIVERSAL_STANDARDS`; intersect with modules that actually exist.
5. Output `(active, not_active)`, universals first in tuple order.

Current archetype → standards map (`infra/config/services.yaml`):
`nextjs-ui → [ui, config, auth, testing, observability]`;
`graphql-subgraph → [service, config, testing, observability]`;
`nest-api → [service, config, auth, testing, observability]`;
`data-pipeline → [data, config, testing, observability]`.

### 4.2 Diff matching (runtime) — `standards_matching_diff`

Changed paths = (merge-base vs `origin/main`|`main` diff) ∪ uncommitted (`git status
--porcelain`), unioned across every git repo/worktree directly under the workspace root.
Each non-universal module matches if any changed path fnmatches any `applies_to` glob; universals
append whenever anything changed. Git layer is best-effort with a 5s timeout and never raises
(it feeds a session-launch hook). Known accepted limitation: `fnmatch` keeps `/` literal, so
repo-root files under-match `**/*.x` globs (worst case: one standard not re-injected).

### 4.3 Precedence tiers (behavioral contract, defined in the entry skills)

When a loaded standard conflicts with the task's framing, resolve by the rule's own weight:

- **Invariant** (must-never rule): the standard wins. Apply it, write a `decision` note, do not
  proceed against it even if the task asks. In review: blocking finding.
- **Rule** (normal STANDARD.md rule): surface the conflict in one line, apply the standard,
  continue. In review: raise, let the author respond.
- **Nit** (style/anti-pattern one-liner): apply silently, tag `phase: review`. In review:
  optional/low-severity.

`decision` notes are binding over task-level instincts; a conflict between a decision note and the
task as given is raised to the user, never silently resolved.

## 5. Delivery artifacts (projected per workspace at `sandbox init-workspace`)

Everything below is **generated or copied into the workspace** — nothing is distributed through a
plugin (projection kills refresh lag; the plugin keeps only global ops skills). Freshness:
`sandbox skills check|sync`.

### 5.1 Generated domain skills — `.claude/skills/tr-<domain>-standard/`

Rendered on the fly from `docs/standards/` by `apps/cli/src/lib/skill_gen.ts`:

- `description:` frontmatter is the composed trigger gate:
  `Sandbox <summary> Use when EDITING, IMPLEMENTING[, OR REVIEWING] <domain> code — files
  matching <applies_to globs>. Not during research/planning, and not for edits outside this
  domain.` (verbs derived from `phase:`).
- Body = STANDARD.md body with links rewritten: sibling-module links become skill references;
  other relative links become canonical GitHub URLs pinned to `multi-feature`;
  `references/` links pass through (the bundle keeps references adjacent).
- Body ends with a **precedence footer** (harness-7 fix) so any load path re-establishes
  precedence, not just `sb-implement`.
- Directory-form references project as `references/<name>.md` beside the SKILL.md, loaded only on
  suspicion of the specific anti-pattern.
- A generated do-not-edit header names the source file and the sync command.

### 5.2 Hand-authored entry skills — `infra/skills/*/SKILL.md`, copied verbatim

| Skill | Phase | What it loads / does |
|-------|-------|----------------------|
| `sb-research` | research/planning | loads nothing; spawns the read-only `sb-researcher` agent |
| `sb-implement` | coding | universal base (`ponytail` plugin + comments + engineering) at entry; reads routing table + notes; loads Active-row standards matching files about to be edited; re-checks per new file type; recitation rule (restate the governing rule at the edit); output-redirect rule (pipe verbose check output to a file, read back only failures); capture-as-you-go notes contract; precedence tiers |
| `sb-test` | testing | loads nothing; spawns `sb-tester-<archetype>` agent(s) |
| `sb-review` | review | universal base + standards covering files in the diff; inline anti-pattern one-liners are the checklist; decision-note violations are findings; precedence tiers as severity ladder |
| `sb-pr` | finishing | pre-PR gate, then `sb-review` |
| `sb-handoff` | any boundary | writes the structured handoff note |
| `sb-author` | authoring | fills graduation scaffolds in `docs/standards/` |

### 5.3 Workspace `CLAUDE.md` — the compiled routing table (`apps/cli/src/lib/claude_md.ts`)

The "Standards routing" section contains: the Active table (`| Standard | Skill | Loads on |`,
where "Loads on" = `applies_to` globs or "any code edit"), an explicit "Not active … — do not
load" line, the phase-entry paragraph naming each entry skill, and the by-phase table. Plus a
Context Budget rule (load only what the routing table points to, ≤3 files/step) and the session
requirement that sessions start at the workspace root.

### 5.4 Generated agents — `.claude/agents/` (`apps/cli/src/lib/agent_gen.ts`)

Principle: **phase gates tools, archetype gates context.**

- `sb-researcher`: `tools: Read, Grep, Glob, Write` (Write solely for the finding note). Return
  contract: write `.sandbox/notes/NNN-finding-<slug>.md`, return a 2–3 sentence summary + note
  path + open questions.
- `sb-tester-<archetype>` (one per archetype present): `tools: Read, Grep, Glob, Bash, Edit`;
  Edit restricted to test files by role. Definition embeds only that archetype's services, their
  resolved test commands, and pointers to its standards. Stale tester agents are pruned on
  re-init.

### 5.5 Generated hook — `.claude/settings.json` (`apps/cli/src/lib/hooks_gen.ts`)

One matcher-less **SessionStart** hook: `command -v sandbox >/dev/null 2>&1 && sandbox notes
context || true`. Fires on every new context window (startup / resume / clear / **post-compaction**).
Marker-based merge preserves all user settings; malformed user JSON is left untouched. There is
deliberately no PreCompact hook (its stdout cannot reach the model).

### 5.6 Notes system — `.sandbox/notes/` (filesystem, harness-independent)

`NNN-<type>-<slug>.md` with frontmatter `type: decision|attempt|contract|finding|handoff`,
`phase`, `author`, `refs`, `status: open|superseded|graduated`. Supersede, never delete.
Contracts: entry skills instruct capture-at-the-moment; agents have return contracts; `sandbox
down` offers graduation of decision notes into `docs/standards/`.

### 5.7 Runtime re-injection — `sandbox notes context` (`apps/cli/src/commands/notes.ts`)

Injected at every session start, ordered (truncation cap is 10k chars, harness-side):

1. **Active-standards block first**: skill name + summary for every standard whose `applies_to`
   matches the branch diff, wording conditioned on the hook `source` (compaction vs fresh), plus
   the compressed **precedence directive** (harness-7: summaries re-anchor awareness, precedence
   restores compliance).
2. Notes preamble + latest handoff + open decision notes (each body capped at 3,500 chars).

Never raises; silently empty outside a workspace.

## 6. Validation gates

- `sandbox standards check` (structural regression gate, CI-able): frontmatter schema, domain/location
  agreement, non-empty `applies_to`, list-form `phase`, reference linkage, no unfilled
  `TODO(graduate)` / `canonical: TODO`, services.yaml ↔ standards drift, archetype drift.
  Scans files directly (upstream of the forgiving loader) so silent-drop breakage is caught.
- `sandbox skills check|sync`: per-workspace projection freshness (missing/stale/orphaned tr-*).

## 7. Context cost profile (measured/estimated)

- Standing cost: ~3–7 tokens per projected skill (headless-measured; TUI unverified).
- `sb-implement` entry: ~3.1k tokens (entry skill + comments + engineering).
- Incremental per domain touched: ui ~340, service ~1,270, config ~330, auth ~440, testing ~240,
  observability ~260 tokens; references ~230–390 each, on suspicion only.
- `sb-review` entry: ~2.6k + diff-matched domains.
- Research/test phases: ~0 main-context tokens (subagent isolation; summary + note pointer back).
- Re-injection block: tens of tokens (pointers + summaries + precedence line, not bodies).

## 8. Evidence base

Measured (all n=3-scale — directions, not effect sizes; harnesses 1–4 on Sonnet, 5–7 on
Opus/Haiku 4.5; details in `docs/experiments/context-management/results/`):

| # | Question | Result |
|---|----------|--------|
| 1 | Standing token cost of skills | ~3–7 tok/skill; bodies fully lazy; description length free |
| 2 | Trigger timing | description-gating collapses (0/16 ui/api); phase-entry chain 15/15 preventive |
| 3 | Subagent tool-gating | instruction/role/gate all 0-edit at N=3; gate = "cannot misbehave" guarantee |
| 4 | Notes persistence | contracted writes 3/3, uncontracted 0/3; read-but-not-applied failure mode identified |
| 5 | Read-but-not-applied fix | precedence block load-bearing (Haiku 0/3→3/3); recitation zero measured keep (kept as insurance) |
| 6 | Loaded→applied baseline | 9/9 applied vs 0/9 control across 3 standards (Haiku) |
| 7 | Post-compaction re-inject | summary-only re-anchor fails under conflicting task nudge (0/3 even enriched); precedence directive is the required ingredient |

Known-unmeasured (deferred, any spend needs explicit approval): whether agents invoke
`sb-implement` unprompted in production sessions (the trigger step on weak models); implement-phase
in a subagent; interactive-TUI standing costs; harness-6 phase baits 4–5; hook coverage across
clients (CLI/VS Code/VK); recitation in the >135K-burial regime.

## 9. Known limitations

1. **The enforcement chain is voluntary.** Nothing verifies `sb-implement` ran before the first
   edit; the precedence block — the one proven-causal artifact — rides on a model-followed
   instruction. (Candidate fixes: PreToolUse backstop hook; `.claude/rules/` migration — see
   `docs/superpowers/specs/2026-07-18-claude-rules-domain-axis-design.md`.)
2. Invariant tier is prose-defined; no machine check of diff compliance against must-never rules.
3. Projection staleness in long-lived workspaces is manual (`skills sync`).
4. fnmatch root-level under-match (accepted, documented inline).
5. 10k hook-output cap bounds how much note context re-injection can carry.

## 10. Portability — what a target harness must provide

The system's logic (content model, resolution, generation, notes, validation) is plain TypeScript +
markdown and ports as-is. The **delivery layer** is the only harness coupling. To re-implement on
a different coding agent, the target must offer:

| Requirement | Used by | Claude Code mechanism | Acceptable substitute |
|---|---|---|---|
| R1. On-demand instruction packages with a standing one-line index and lazy bodies | domain skills, entry skills | `.claude/skills/` (description standing, body on invoke) | any lazy-loadable instruction file the agent is told to read (entry skill says "read `<path>`"); worst case: `Read` tool + strong file identifiers |
| R2. Always-on project instruction file for the routing table | CLAUDE.md routing block | `CLAUDE.md` | `AGENTS.md` or equivalent |
| R3. Session-start injection hook (fires on new windows *and* post-compaction), stdout→context, with a known output cap | notes + standards re-injection | SessionStart hook (`source` field distinguishes compaction) | any session-lifecycle hook that can run a CLI and inject text; if absent, fold re-injection instructions into R2 and accept weaker post-compaction behavior |
| R4. Subagent definitions with tool allowlists | sb-researcher, sb-tester-* | `.claude/agents/` frontmatter `tools:` | any agent-spawn primitive with tool restriction; if only role-prompting is available, accept "reliably behaves" instead of "cannot misbehave" (harness-3) |
| R5. Plain filesystem access in the workspace | notes, handoffs, generation targets | — | universal |
| R6. (Optional, upgrade) Path-glob-conditional rule injection evaluated per model call | replaces the voluntary domain-loading chain | `.claude/rules/` `paths:` frontmatter | Cursor rules globs; OpenCode via the `opencode-rules` plugin (`globs:` frontmatter + per-call system-prompt transform + compaction hook) |

Port checklist: (1) point the generators' output paths at the target's skill/agent/rules
locations; (2) re-express the SessionStart hook in the target's hook config; (3) re-run
harness-6-style loaded/control cells and a harness-7-style post-compaction cell on the target —
the behavioral results are harness-specific and must be re-earned, not assumed. If the target
supports R6, deliver each rule with the precedence directive embedded (harness-7: content without
precedence does not produce compliance).

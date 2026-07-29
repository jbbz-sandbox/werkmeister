# JIT Context System — current-state index

> **This is the one doc kept current.** It states *what exists today* and points into the
> design specs for *why*. The specs are append-only design records (with dated amendment
> trails); when they disagree with this file on current state, this file wins. Applying the
> system's own rule to its own docs: **point, never copy.**

## What it is

A just-in-time context system for ephemeral sandbox workspaces: surface coding standards,
tools, and working notes **only when the work matches** — scoped to the workspace's actual
repos and the current phase — instead of one always-on monolithic guide. Modeled on ICM's
layered loading (arXiv:2603.16021) and ponytail's single-source rule sync.

## The three subsystems (ICM layers)

| Layer | Subsystem | Gates | Spec | Status |
|-------|-----------|-------|------|--------|
| 0–3 | **Standards loading** | *rules* | [jit-standards-loading-spec.md](jit-standards-loading-spec.md) | shipped |
| 4 (tools) | **Agents & tools** | *tools + isolation* | [jit-agents-and-tools-spec.md](jit-agents-and-tools-spec.md) | steps 1–5 shipped; step 6 (review/plan agents) deferred |
| 4 (working) | **Notes & handoffs** | *write side / persistence* | [jit-notes-and-handoffs-spec.md](jit-notes-and-handoffs-spec.md) | steps 1–6 shipped |

Phase-2 content work (content depth, SDLC coverage, creation-time tailoring, authoring
pipeline) is executed and closed — see [jit-content-HANDOFF.md](jit-content-HANDOFF.md)
(historical). The 2026-07-17 service-merge work is the most recent standards change.

## Current standards domains

Standards live at `docs/standards/<domain>/STANDARD.md` (+ `references/*.md`, lazy-loaded).
They load by `applies_to` file-path glob matched against a diff; `comments` is the sole
"any code edit" exception. There is **no keyword/content trigger.**

| Domain | Covers |
|--------|--------|
| `service` | **Service-boundary contract — REST/Nest *and* GraphQL federation/Relay**, plus cross-service resilience, contract evolution, query performance |
| `config` | Inter-service URL/DNS conventions, env-var rules, no host-relative/templated addresses |
| `auth` | Auth0 audience scoping per service, ID- vs access-token, shared-session cookie scope |
| `testing` | Unit vs integration vs contract tests; what to mock at a service seam |
| `observability` | OTel span/attribute conventions, structured logging, trace/correlation-ID propagation |
| `comments` | Universal "comments explain the why, not the what" rubric (the universal base) |
| `data` | Airflow ordering/scheduling, epoch-ms conventions |
| `ui` | Render/effect ordering, hydration, CDN caching |
| `repos/` | Per-repo quirk snippets (projection still parked — see the TODO doc) |

### Domain renames you'll see in older docs

The 2026-07-17 service-merge work
([spec](superpowers/specs/2026-07-17-service-config-auth-domains-design.md)) changed the
domain set. Older docs (the standards spec §5.1/§5.5, the Phase-2 handoff) predate it:

```
old api      ─┐
old graphql  ─┼─►  service   (+ resilience, + contract-evolution, + performance)
             ─┘
   new: config, auth, testing, observability   (pain-driven, each from a documented war story)
```

**GraphQL was absorbed, not dropped.** Its rules (federation `@key`, Relay/cursor
pagination, dataloader fan-out) are the `### GraphQL` subsection of `sb-service-standard` —
there is no standalone `graphql` domain or `sb-graphql-standard` skill anymore.

## Where each piece lives (code)

Standards → skills → workspace, all generated from `docs/standards/` at point of use
(no committed skill copies; generation-at-use can't drift):

- **Standards resolution / archetypes** — `apps/cli/src/lib/standards.ts`, `apps/cli/src/lib/archetypes.ts`
- **Skill rendering / projection** — `apps/cli/src/lib/skill_gen.ts` (`generate_skills`),
  `apps/cli/src/lib/workspace_skills.ts` (projects `.claude/skills/tr-*` per workspace)
- **CLAUDE.md routing table** — `apps/cli/src/lib/claude_md.ts` (`build_standards_routing_section`)
- **Subagents (`.claude/agents/`)** — `apps/cli/src/lib/agent_gen.ts` (`sb-researcher`,
  `sb-tester-<archetype>`)
- **MCP projection (`.mcp.json`)** — `apps/cli/src/lib/mcp_gen.ts`
- **Notes layer** — `apps/cli/src/lib/notes.ts`, `apps/cli/src/commands/notes.ts` (`sandbox notes
  context` / `graduate`), `docs/notes-conventions.md`; SessionStart hook via
  `apps/cli/src/lib/hooks_gen.ts`; teardown print via `apps/cli/src/commands/down.ts`. `notes
  context` also re-injects diff-matched active standards' one-liners
  (`standards.standards_matching_diff`) so compaction-squashed standards get
  re-anchored — see specs/2026-07-18-context-compression-standards-reinjection-design.md.
- **Authoring pipeline** — `apps/cli/src/lib/graduate.ts` (`graduate_note`, `eligible_domains`),
  `infra/skills/sb-author/`
- **Entry skills (hand-authored)** — `infra/skills/`: `sb-research`, `sb-implement`,
  `sb-test`, `sb-handoff`, `sb-review`, `sb-pr`, `sb-author`

**Graduation eligibility** is computed from content shape (a STANDARD.md carrying both
`## Rules` and `## Don't`), not a fixed list. Today that's **`service`, `auth`, `config`,
`observability`, `testing`**; `comments`/`data`/`ui` were directory-migrated with content
unchanged and aren't eligible yet.

## Validation gates

- `sandbox standards check` — structural gate over the `docs/standards/` **source**
  tree: `validate_standard_modules` (frontmatter integrity + summary/applies_to/phase
  shape + domain-matches-location) plus `validate_module_references` and
  `validate_service_standards`. Exits 1 on any malformed standard; asserted clean by
  `standards.test.ts::test_real_standards_tree_is_valid` so the suite catches regressions
  (`apps/cli/src/commands/standards.ts`).
- `sandbox skills check` / `sync` — staleness of projected workspace skills
  (`apps/cli/src/commands/skills.ts`)
- `validate_module_references` — fails on dead pointers, lingering `TODO(graduate)`
  markers, or placeholder `canonical: TODO`

## Open / parked work

- **Repo-local doc exposure** — [TODO-repo-docs-jit-exposure.md](TODO-repo-docs-jit-exposure.md)
  (research-needed; predates the service merge — re-scope against the `service` domain
  before starting)
- **Deferred agents** — review agents, plan agent (agents spec step 6)
- **Measurement backlog** — several acceptance re-runs and open questions in the specs'
  §6 (read-but-not-applied at scale, main-agent capture compliance, hook semantics across
  launch paths)

## Phases are tool-gates, not workflow stages

A "phase" in this system (`sb-research` / `sb-implement` / `sb-test`) exists to bind a
**toolset + isolation profile** — *"phase gates tools, archetype gates context"*
(agents spec §3). It is **not** an SDLC workflow label. Add a phase only when it changes
the gate; do not add one that shares a gate with an existing phase.

This matters when integrating a design→plan→implement framework (e.g. Superpowers).
Those *workflow stages* map onto the existing *tool-gates* — don't re-create them as phases:

| Workflow stage | Rides tool-gate | Why |
|---|---|---|
| research / **design** / **plan** | `sb-research` (read-only + doc/notes write) | all three are read-only exploration that writes a *doc, never source* — one profile |
| implement | `sb-implement` (full edit tools, **main agent**) | live human correction is the point (agents spec §4.4) |
| test | `sb-test` (run/edit-tests, per-archetype subagent) | — |

So **do not add `sb-design` / `sb-plan` phases** — they gate nothing new (the agents spec
§3 already resolved `plan` with "the built-in Plan agent" rather than a dedicated skill).
Design and plan are represented by their *artifacts*, which already flow through existing
machinery: decisions → `decision` notes (binding, read by `sb-implement`), specs →
`docs/superpowers/specs/`, plans → `docs/superpowers/plans/`. Let the framework drive the
stage cadence on top of the gates.

Whether *implement* can safely move into a subagent (concurrent implementation) is an open,
**unmeasured** question — see Harness 5 in
[experiments/…/RESULTS.md](experiments/context-management/results/RESULTS.md) "What to run
next". Until it's measured, implement stays in the main agent.

## Conventions when extending

- **New workstream ⇒ new handoff.** Don't extend a closed handoff; start a fresh
  brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) →
  implement cycle, and update *this* index with the resulting current state.
- **New standards rules graduate through the pipeline** (`decision` note → `graduate` →
  `sb-author`); repo docs are the deep-reference tier those rules link to, never a second
  rules channel.

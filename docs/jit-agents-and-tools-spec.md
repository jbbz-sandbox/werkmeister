# Just-in-Time Agents & Tools — Design Spec

> **Status:** Build steps 1–2 SHIPPED 2026-07-04 (archetype registry + normalization;
> generated `sb-researcher` + retargeted `sb-research`). Steps 4–5 SHIPPED 2026-07-04
> (archetype `test:` commands + per-service overrides, generated `sb-tester-<archetype>`
> agents + `sb-test` entry skill; MCP `.mcp.json` projection). Step 6 deferred. Companion to
> [jit-standards-loading-spec.md](jit-standards-loading-spec.md) — that spec gates
> *standards context* for a single agent; this one gates **tools + context + isolation**
> via generated subagents and a service **archetype** registry.
> **Author:** design sessions 2026-07-03/04, distilled from
> [context-management-research.md](context-management-research.md) §5a (threads 8–10).
> **Scope:** sandbox. Affects `infra/config/services.yaml`,
> `apps/cli/src/lib/standards.ts` (generalizes), the workspace generator, and a new
> per-workspace `.claude/agents/` output.
> **Evidence base:** every load-bearing assumption here is measured — see
> [experiments/context-management/results/RESULTS.md](experiments/context-management/results/RESULTS.md).

## 1. Summary

The standards spec answers "which *rules* load when." This spec answers the wider question
the same workspaces raise: **each phase of work (research / plan / implement / test /
review) wants a different *toolset*, and each service type (GraphQL subgraph / UI package /
REST API / data pipeline) wants different *context*.** Neither is expressible with skills
alone — a skill can suggest tools but cannot grant, restrict, or isolate them.

The design: a **service archetype registry** in `services.yaml` becomes the single source
from which the workspace generator projects *all* JIT surfaces — the standards routing
table (already shipped), per-workspace **subagent definitions** (`.claude/agents/*.md`,
tool-gated per phase), and per-workspace **MCP server enablement**. Orchestration stays
**human-in-the-loop**: the main agent is the dispatcher; phases are user-invoked; spawned
subagents return findings + open questions for the human to resolve before the next phase.

## 2. Measured foundations (why this shape)

Four empirical results (harnesses 1–3, RESULTS.md) constrain the design:

1. **Skill standing cost is negligible** (~3–7 tok/skill, bodies fully lazy) → the number
   of generated skills/agents is not a token concern; inspectability and trigger accuracy
   are the design constraints.
2. **Description-only triggering silently misses common file types** (ui/api 0/16) while
   **phase-entry loading is deterministic in practice** (15/15 PREVENTIVE, identical chain
   every trial) → anything that must not be missed loads at *phase entry*, and phase entry
   is therefore the natural place to bind toolsets too.
3. **An un-gated, un-instructed agent edits 100% of the time on an investigate-only task**
   — and then fails to report the findings that were asked for (0/3) → research needs a
   structural boundary, not politeness.
4. **The `tools:` gate is a guarantee, not a behavioral delta** — instruction-only and
   role-framing-only also reached 0 edits (3/3 each) → gate *and* frame: role-framing does
   the everyday work; the `tools:` line makes misbehavior impossible. Both are one line of
   generator output.

## 3. Conceptual model — four axes, two orthogonal dimensions

The standards spec's three axes (phase / domain / repo-presence) gain a fourth: **tools**.
The factoring that keeps the agent matrix from exploding:

> **Phase gates *tools*. Archetype gates *context*.** They are orthogonal — compose them,
> never cross-product them.

| Phase | Toolset character | Agent form |
|-------|-------------------|-----------|
| research | read-only (`Read, Grep, Glob` + search/docs MCP) | **one shared subagent** (isolation is a win: exploration bulk stays out of the main context) |
| plan | read-only + web/docs | **one shared subagent** (or the built-in Plan agent) |
| implement | full edit tools | **main agent** (isolation is a *cost* here — the user watches and corrects live; HITL in its strongest form) |
| test | run/edit-tests + browser/preview tools | subagent per archetype *present* |
| review | read-only + diff tools | subagent (or existing review tooling) |

Archetype contributes the *context* to whichever agent runs: standards skills (already
shipped), reference docs, run/test commands, and which MCP servers are worth connecting.

A typical 2-archetype workspace generates **~5–7 agent definitions, not 30**: shared
research + plan, per-archetype test, and implement stays main-loop.

## 4. Components

### 4.1 `archetype:` in services.yaml — the single control surface

Generalizes the shipped `standards:` field into a named bundle:

```yaml
# services.yaml
archetypes:
  nextjs-ui:
    standards:   [ui]
    mcp_servers: [context7]
    agent_tools: [Read, Grep, Glob, Edit, Write, Bash]
    reference:   []                      # repo-relative or URL docs worth loading
    test:        "yarn turbo run test --filter={service}"
  graphql-subgraph:
    standards:   [graphql]
    mcp_servers: [context7]
    agent_tools: [Read, Grep, Glob, Edit, Write, Bash]
    reference:   []
    test:        "yarn turbo run test --filter={service}"
  nest-api:
    standards:   [api]
    ...
  data-pipeline:
    standards:   [data]
    ...

services:
  web-v2:          { ..., archetype: nextjs-ui }
  federated-graph: { ..., archetype: graphql-subgraph }
```

**Migration (decided 2026-07-04):** `standards:` shipped first and stays valid. The loader
normalizes a bare `standards: [ui]` into an anonymous archetype `{standards: [ui]}` — both
forms coexist, no flag day. `apps/cli/src/lib/standards.ts` grows into (or is joined by)
`apps/cli/src/lib/archetypes.ts` doing that normalization; `resolve_active_standards()` becomes a
projection of the archetype resolution.

**`test:` amendment (step 4, shipped 2026-07-04):** the test command turned out to be a
property of the *repo's tooling* (turbo vs nx vs plain yarn), which an archetype default
cannot always know — nextjs-ui spans web-v2 (econx/turbo) and web-v1 (sb-web/plain jest).
So the archetype `test:` is the default template (`{service}` expands to the service
name) and a service may set its own `test:` override, which wins
(`apps/cli/src/lib/archetypes.ts::service_test_command`). Overrides also cover services whose
package name differs from their service name (e.g. `interview-api` →
`--filter=interview-service`). All commands run from the service's repo root inside the
workspace.

### 4.2 Generated subagents — `.claude/agents/*.md` per workspace

The workspace generator (same flow that writes the Standards routing block) emits agent
definitions from the archetypes *present in the workspace*:

```markdown
---
name: sb-researcher
description: Research agent for this workspace. Investigates code and reports findings
  with proposed fixes. Writes findings to .sandbox/notes/; never modifies source files.
tools: Read, Grep, Glob, Write
---
You investigate code in this workspace and report findings.
RETURN CONTRACT: write your full findings (root cause, evidence with file:line refs,
proposed fix, OPEN QUESTIONS / AMBIGUITIES) to .sandbox/notes/NNN-finding-<slug>.md
(next free NNN, conventions frontmatter); return only a 2-3 sentence summary, the note
path, and the open questions.
Do not modify source files — the implement phase is a separate, user-invoked step.
Workspace context: read CLAUDE.md first (routing + standards tables).
```

*(Amended 2026-07-04, notes-spec step 6: the return contract now persists findings as a
`.sandbox/notes/` `finding` note — `tools:` grew `Write`, measured safe in harness 4;
the original read-only definition shipped with step 2 is in git history.)*

```markdown
---
name: sb-tester-nextjs-ui        # one per archetype PRESENT, only for test phase
description: Runs and interprets tests for this workspace's Next.js UI services (web-v2).
tools: Read, Grep, Glob, Bash, Edit
---
Run: `yarn turbo run test --filter=web-v2` (from the archetype's `test:` command).
Edit only test files. Report failures with the failing assertion and suspected cause.
Apply the ui standard (sb-ui-standard) when writing test code.
```

Design rules (each anchored to a measurement):
- **Role-frame *and* tool-gate every agent** (finding 4: frame for behavior, gate for the
  guarantee).
- **Return contract is part of the definition** — findings + open questions, because
  subagents cannot talk to the user (see §4.4) and finding 3 shows un-contracted agents
  drop the report entirely.
- **Union rule (decided 2026-07-04):** `mcp_servers` unions across present archetypes at
  the workspace level (connection is cheap — schemas defer until ToolSearch);
  `agent_tools` is **never** union'd — one narrow specialist per present archetype.
  Cross-cutting changes belong to the full-tooled main agent.
- Generated files carry the same do-not-hand-edit header as other projections; regenerated
  on `sandbox init-workspace` / `up`.

### 4.3 Phase entry — extends the standards spec's `sb-implement`

The standards spec's phase-entry skills (its §5.6) gain tool semantics:

- `sb-research` — body now says: *spawn `sb-researcher` for the investigation; relay its
  findings; put its open questions to the user before proposing next steps.* (It cannot
  merely say "don't load standards" — finding 3 shows the main agent will edit anyway.)
- `sb-implement` — unchanged mechanism (15/15 validated): loads the universal base +
  routing-table matches **in the main agent**, which keeps its full toolset.
- `sb-test` — new: reads the routing/archetype tables, spawns the matching
  `sb-tester-<archetype>` agent(s), relays results.

### 4.4 Orchestration — human-in-the-loop (decided 2026-07-04)

Grounded in a mechanism fact: **subagents cannot converse with the user** — no
AskUserQuestion, no mid-run checkpoint. Therefore:

- The **main agent is the dispatcher**; only it pauses to ask the human.
- **Phases are user-invoked** (`/sb-research`, `/sb-implement`, `/sb-test`) — no autonomous
  phase chaining.
- Every spawned agent's **return contract** includes open questions/ambiguities; the main
  agent surfaces them via AskUserQuestion **before** dispatching the next phase.
- Implement stays in the main conversation (the user watches and corrects live).

### 4.5 MCP server enablement per workspace

The generator writes the union of present archetypes' `mcp_servers` into the workspace's
`.mcp.json` (or documents them in the routing table for manual enablement — resolve at
build time which surface the harness respects). Cheap to over-grant (deferred schemas);
the win is *not connecting* servers no archetype wants.

**Resolved at build time (step 5, shipped 2026-07-04):** project-scope `.mcp.json` at the
workspace root is the surface — every launch path (CLI, desktop, VK sessions) starts with
cwd at the workspace root and the harness prompts for approval on first use; a docs-only
table would connect nothing. Server *definitions* live in a new top-level `mcp_servers:`
registry in services.yaml (verbatim `.mcp.json` bodies; secrets stay out via `${VAR:-}`
session-start env expansion). `apps/cli/src/lib/mcp_gen.ts` merges — its managed namespace is the
registry's names (added, refreshed, pruned); user-added servers under other names are
preserved, and unparseable files are left untouched (same policy as the hooks generator).

## 5. Build plan (sequenced, each independently shippable)

1. **Archetype registry + normalization** (§4.1) — **SHIPPED 2026-07-04.**
   `archetypes:` block (nextjs-ui / graphql-subgraph / nest-api / data-pipeline, with
   `standards:` + `mcp_servers:` fields; `test:`/`reference:`/`agent_tools:` arrive with
   steps 4–5), `archetype:` per service (federated-graph maps to graphql-subgraph per the
   §4.1 example), new `apps/cli/src/lib/archetypes.ts` normalizes legacy `standards:` into an
   anonymous archetype; `resolve_active_standards` reads through it. Routing block output
   verified identical (`apps/cli/src/lib/__tests__/archetypes.test.ts::test_real_registry_matches_pre_archetype_resolution`).
2. **Generated `sb-researcher`** (§4.2) — **SHIPPED 2026-07-04.** `apps/cli/src/lib/agent_gen.ts`
   emits `.claude/agents/sb-researcher.md` on `sandbox init-workspace` (step 6b); the
   `sb-research` entry skill now spawns it (with inline read-only fallback for
   pre-existing workspaces) and surfaces its open questions via AskUserQuestion. Tests:
   `apps/cli/src/lib/__tests__/agent_gen.test.ts`. **Extended same day** by notes-spec step 6: the
   return contract now writes a `.sandbox/notes/` finding note (see amendment in §4.2).
3. **Standards-spec steps 4–5** (domain skills + `sb-implement`) — unchanged, from the
   companion spec; `sb-implement` is already validated 15/15.
4. **Per-archetype test agents + `sb-test`** (§4.2/§4.3) — **SHIPPED 2026-07-04.**
   Archetype `test:` templates + per-service overrides in services.yaml (see the §4.1
   amendment); `apps/cli/src/lib/archetypes.ts` grew `service_test_command` +
   `resolve_present_archetypes` (same selected-services-win presence rule as standards
   resolution; anonymous legacy archetypes excluded — no name to key an agent on);
   `apps/cli/src/lib/agent_gen.ts` emits one `sb-tester-<archetype>.md` per present archetype
   (tools `Read, Grep, Glob, Bash, Edit`; body carries the exact per-service commands,
   the archetype's `tr-*-standard` pointer for test code, and a BLOCKED-aware return
   contract) and prunes testers for archetypes no longer present; new hand-authored
   `sb-test` entry skill dispatches them; the CLAUDE.md routing block's phase table
   gained the testing row. Tests: `apps/cli/src/lib/__tests__/archetypes.test.ts`,
   `apps/cli/src/lib/__tests__/agent_gen.test.ts`.
5. **MCP enablement projection** (§4.5) — **SHIPPED 2026-07-04.** See the §4.5
   resolution; `apps/cli/src/lib/mcp_gen.ts` + `mcp_servers:` definition registry, wired as
   init-workspace step 6d. Tests: `apps/cli/src/lib/__tests__/mcp_gen.test.ts`.
6. **(Deferred)** review agents; plan agent (the built-in Plan agent may suffice).

## 6. Open questions (not blockers for steps 1–2)

1. **Cross-model behavior** — all rates are sonnet; sweep opus/haiku before treating the
   3/3s as universal (RESULTS.md "what to run next").
2. **Ambiguous-prompt degradation** — instruction-gating likely degrades before tool-gating
   when the fix-vs-report intent is unstated; measure before relying on instruction-only
   anywhere.
3. **Context-isolation win, quantified** — parent tokens with subagent research vs. inline
   research (thread #9's isolation claim; assumed, not yet measured).
4. **`.mcp.json` generation semantics** — ~~whether per-workspace MCP config is honored
   in all launch paths (CLI, desktop, VK sessions)~~ — resolved with step 5 (§4.5):
   project-scope `.mcp.json` is the documented cross-launch-path surface; first-use
   approval prompts are acceptable friction. Verify empirically across launch paths if a
   path turns out not to prompt (measurement backlog).

## 7. References

- [context-management-research.md](context-management-research.md) §5a — decisions and
  research trail (threads 8–10).
- [jit-standards-loading-spec.md](jit-standards-loading-spec.md) — the standards companion;
  its build steps 1–3 shipped 2026-07-04.
- [experiments/context-management/results/RESULTS.md](experiments/context-management/results/RESULTS.md)
  — harnesses 1–3 raw + interpreted results.

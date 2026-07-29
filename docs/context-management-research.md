# Context Management Research — JIT Standards & Context Loading

> **Status:** Research findings / living document. Captures the goals, research, and
> conclusions from the design exploration on **2026-06-29**, and frames the open
> threads worth pursuing next.
> **Scope:** sandbox — ephemeral, multi-repo, multi-feature workspaces.
> **Companion doc:** [jit-context-system.md](jit-context-system.md) is the
> implementation handoff that came out of this research. This document is the *why* and the
> *research trail*; that one is the *what to build*.

---

## 1. Goals

The exploration started from four explicit goals:

1. **Just-in-time standards.** Introduce high-level code standards to agents *only when
   relevant* — not as an always-on preamble.
2. **Token conservation.** Only create/inject the context needed, when it's needed. Keep the
   standing (always-in-context) footprint minimal.
3. **Phase-aware context.** Some docs (e.g. `code-style-guide.md`) matter at *coding* time but
   not during *research*; others matter only during research/planning.
4. **Domain- and repo-aware context.** GraphQL docs only on GraphQL work, UI docs only on UI
   work — and only for the repos that actually exist in a given ephemeral workspace (which can
   contain *any combination* of repos).

Two external references were brought in as candidate solutions:

- **[ponytail](https://github.com/DietrichGebert/ponytail)** — a Claude Code plugin whose rules
  the user wanted to integrate.
- **ICM (Interpretable Context Methodology)** — a layered context-loading methodology the user
  had seen but didn't yet know how to apply.

Constraint: **explore before building** — no code until the solution shape was agreed.

---

## 2. Starting state (what the sandbox does today)

- **`CLAUDE.md` is always-on and links out** to `code-style-guide.md` on GitHub — the style
  guide is *named* every session but never gated by phase or domain, and isn't even copied into
  the workspace.
- **`code-style-guide.md` is a monolith** — one shared "comments" rubric plus ~9 per-repo note
  blocks. A web-only workspace still carries unrelated per-repo notes if
  the file is ever read.
- **`services.yaml` already knows the repo/service composition** of every workspace — but
  nothing maps a service to *which docs matter*. **That linkage is the missing wire.**
- **Skills already ship** (`sandbox-tools` plugin). Skills are Claude Code's *native* JIT loader
  — a skill's body only enters context when its description matches the work — but they weren't
  being used for standards.

---

## 3. Research findings

### 3.1 The three independent gating axes

Every piece of standards context should be gated on one or more of three axes. Untangling them
was the central insight — each axis has a *natural* mechanism:

| Axis | Question | Example | Best mechanism |
|------|----------|---------|----------------|
| **Phase** | research vs. coding vs. review? | "style guide at coding time, not research" | ICM stages / a CLAUDE.md routing rule / a phase-entry skill |
| **Domain** | GraphQL? UI? API? | "GQL docs only on GQL work" | **Skill descriptions** (or file-glob hooks) |
| **Repo presence** | which repos are in this ephemeral workspace? | "any combination of repos" | **`services.yaml` registry** |

**Anti-pattern:** putting content into the always-on `CLAUDE.md`. Keep `CLAUDE.md` a **map, not
the territory** — and let the three axes pull modules in on demand. That's where the token
savings come from.

### 3.2 Token mechanics — the pivotal finding

Standing cost (always in context) vs. cost-when-fired differs sharply by mechanism, and this
reshaped the recommendation:

| Mechanism | Standing cost (always in context) | Cost when it fires |
|-----------|-----------------------------------|--------------------|
| **Hook** | **Zero.** Hooks live in `settings.json` and are run by the *harness*, not the model. The model never sees a hook until it fires. | Only the text the hook injects. |
| **Skill** | **Small but nonzero.** Every available skill's `name + description` (~20–50 tok) loads at session start so the model knows it *can* trigger. The **body** stays lazy until invoked. | The body, once. |

Implications:
- **Many *hooks* do not accumulate standing context** — ten hooks cost the same as zero. You pay
  only when one fires. (Same pattern as deferred-tool / ToolSearch schema loading.)
- **Many *skills* accumulate only their one-line descriptions**, not their bodies. Five
  standard-skills ≈ 150–250 tok always-on; the expensive rule bodies stay out until triggered.
- Therefore: **hooks are strictly cheaper for standing tokens** (crude, deterministic, glob/event
  driven); **skills are smart** (intent-driven) at the price of a tiny description. Lean on
  skills for smart loading + hooks as a free deterministic backstop.

### 3.3 Where ICM fits — borrow the loading principle, not the pipeline

- **Don't adopt** ICM's script→production stage pipeline wholesale.
- **Do borrow** the **stage `CONTEXT.md` Inputs table** — an explicit declaration of exactly
  which files (and even which *sections*) to load. That is the phase axis made self-documenting.
- **ICM never changes the working directory.** A "stage" is *a declared set of files to pull in*,
  not a `cd`, a worktree, or a separate process. The `../` relative paths in ICM's Inputs table
  are written as if from inside the stage folder, which only *looks* like a chdir. The agent just
  `Read`s those paths. → Stages can sit *inside* the existing worktree root as a read-scoping
  convention; no directory-hopping required.
- Adopt full stage folders **only if** you also want human review gates between steps.

### 3.4 Where ponytail fits — two distinct things, don't conflate

1. **Install it as-is.** It's a plugin (`/plugin marketplace add DietrichGebert/ponytail`); its
   "decision ladder / write less code" ruleset is itself a high-level coding standard — it
   becomes one of the coding-phase modules. You don't reimplement it.
2. **Copy its architecture:** single-source rule text synced across formats + **lifecycle hooks
   that inject the ruleset at turn boundaries** + a level command (`/ponytail lite|full|off`).
   That hook pattern is the deterministic fallback if skill-description triggering proves
   unreliable.

### 3.5 Skills ≈ ICM routing table — and what *doesn't* survive the fusion

A skill is essentially **ICM's Layer-1 routing entry fused with its Layer-2/3 payload** — the
trigger and the thing it loads packaged as one unit. Correspondence:

| ICM | Skill | Same? |
|-----|-------|-------|
| Layer 1 routing table ("which stage handles this") | `description` field ("use when X") | **Yes, functionally** |
| Layer 2 contract — Process section | skill body instructions | Yes |
| Layer 3 reference — "what rules apply" | skill body content | Yes |
| Layer 2 **Inputs table** — names exact files *and sections* | a "load X" list you write inside the body | Partly |

Two ICM properties **do not survive** the fusion — and both matter for a governance/consistency
goal:

1. **Routing becomes emergent, not explicit.** ICM's Layer 1 is *one file you open and read* —
   the whole routing map, inspectable and diffable. Skill routing is the model arbitrating across
   N scattered `description` fields; there is no single place showing "here is everything that
   loads when." Automatic matching is *convenient* but not *inspectable*.
2. **The Inputs table is more precise than a description.** ICM Layer 2 can say "load *section 3*
   of voice.md"; a description just fires a fixed body. Skills also have **no ordering** — ICM
   folder numbers encode sequence; skills are situational.

**Design takeaway:** keep a **thin explicit routing layer on top of skills** to recover the
inspectability and section-precision that automatic matching gives up.

### 3.6 Controlling which skills load in which phase

There is **no built-in "phase" dial** in Claude Code. What you control per-phase is not whether a
skill's *description* is present (it always is, for the whole session) — it's whether the **body**
gets invoked. Three levers:

1. **Encode the phase into the description trigger** (native, recommended) — e.g. *"Use when
   EDITING OR IMPLEMENTING GraphQL … not for research/planning."* The phase gate falls out of the
   domain gate for free; costs only the one-line description. Downside: model-honored, not
   deterministic.
2. **A phase entry-point skill** (deterministic, user-driven) — make the phase itself invocable
   (`/sb-implement`, `/sb-research`), and let its body name exactly what to load. This is how the
   installed **GSD** skills already work (`/gsd-discuss-phase`, `/gsd-plan-phase`, …). Cleanest
   fit for "style guide at coding time, not research."
3. **Swap the surfaced set between sessions** (profiles) — `gsd-surface` toggles what's in the
   system prompt, but it's *session-level*, not within-session. Heavier; only worth it with many
   skills.

A hook can *assist* by injecting phase **state** ("Phase: coding — domain standards now apply"),
but **a hook cannot invoke or unload a skill** — skill bodies are model-invoked off descriptions.
Hooks set the signal; descriptions/commands act on it.

### 3.7 Loading *timing* — the finding that changed the design

The question "does the code-edit event happen *after* the first LLM pass?" exposed a subtlety:

| Mechanism | When it fires | Can it shape the first draft? |
|-----------|---------------|-------------------------------|
| **Phase-entry load** (`sb-implement`, or a `SessionStart`/`UserPromptSubmit` hook) | **before** the model generates | **Yes — preventive.** In context for the first pass. |
| **Skill description match** ("use when editing…") | usually before the edit, at the model's discretion | Often, but **not guaranteed** — the model can start writing before invoking. |
| **`PreToolUse(Edit\|Write)` hook** | **after** the model emits the Edit/Write call, before disk | **No.** The code is already drafted — it *is* the tool-call argument. Only forces a revision pass. |

Consequence: **a `PreToolUse(Edit)` event happens *after* the first code pass.** "Load on the edit
event" is *reactive* (review/refactor), not *preventive*.

- For **comment standards** that's tolerable — you can tidy comments after a draft.
- For **ponytail** it defeats the purpose. Ponytail's value is the decision-ladder *before*
  writing ("does this need to exist? already in the codebase? stdlib?"). Run after the
  over-engineered code exists, it's just a refactor. Ponytail's README injects "at LLM turn
  boundaries" precisely for this reason.

---

## 4. Conclusions (the agreed design shape)

Wire **each axis to its natural mechanism**, and add a thin explicit routing layer for control:

1. **Break the monolith into modules** under `docs/standards/` — `comments.md`, `graphql.md`,
   `ui.md`, `api.md`, plus per-repo snippets. Each carries frontmatter (`domain:`, `applies_to:`
   globs, `phase:`). Single source of truth.
2. **Repo axis → `services.yaml`.** Add `standards: [ui, graphql]` per service. The workspace
   generator already knows the repo combo, so it computes and writes an **"Active standards"**
   line per workspace. A web-only workspace never hears about data-pipeline notes.
3. **Domain axis → skills.** One thin skill per module, sharp trigger description, generated from
   the `docs/standards/*.md` source (ponytail's single-source pattern). Native JIT, near-zero
   standing cost.
4. **Phase axis → a phase-entry skill + an explicit routing table** in the generated `CLAUDE.md`
   (ICM Layer 1, made inspectable). The entry skill *reads* the table rather than carrying the
   map, keeping routing in one place.
5. **Universal coding base loads at phase entry, before any code is written:** **`sb-ponytail` +
   `sb-comments-standard`**, then the file-matched domain rows. This is the decision that came out
   of §3.7 — prevention rules must precede the first draft.
6. **Enforcement (optional, deferred) → a glob hook** — zero standing cost, add later if
   description-triggering demonstrably misses. **Valid only for review-tolerant standards
   (comments); never a valid home for ponytail**, which must be preventive.

**The synthesis in one sentence:** *skills are ICM's content layers with automatic routing; you
re-add a one-line explicit routing table (compiled from `services.yaml` + `workspace.yml`) to
recover the inspectability and section-precision that automatic matching gives up — and you
anchor prevention-critical rules (ponytail) to phase entry, because the edit event fires too
late.*

### 4.1 Settled decisions (from the spec's §7)

1. **Content-in-body, not a pointer.** Skills install globally, so a content body works in any
   workspace; a "Read docs/standards/x.md" pointer only resolves when sandbox is itself
   a workspace repo (rare) and would silently fail. Bodies stay lazy-loaded — no standing penalty.
2. **Generate skills from the docs + a CI drift check.** Two hand-maintained copies guarantee
   drift; a check alone only detects it after the fact. A thin generator makes
   `docs/standards/*.md` the unambiguous source; CI fails on out-of-sync edits.
3. **`comments` loads on any code edit, never during research.** The rubric governs *writing*
   comments — irrelevant to read-only research.
4. **Defer the glob hook.** Zero standing cost means it can be added later with no redesign.

---

## 5. Open threads — where to take the research next

Threads #1 and #2 have now been measured — see
[experiments/context-management/](experiments/context-management/) and its
[RESULTS.md](experiments/context-management/results/RESULTS.md). Findings below; the rest
remain open.

1. **Verify the token model empirically.** — ✅ **MEASURED (2026-07-03, headless `-p`, sonnet).**
   Original estimate: ~20–50 tok per skill description. Measured reality: **~3–7 tokens per
   skill, and description length has *zero* effect** (a 3,000-tok description costs the same as a
   50-tok one — the full text isn't injected verbatim in headless mode). **Bodies confirmed fully
   lazy** — growing 20 skills' bodies 40× moved standing cost by 3 tokens (noise). 50 skills cost
   149 tokens total. *Refined conclusion:* token cost is **not** a reason to limit skill count or
   trim descriptions; optimize descriptions for trigger accuracy, not length. **Still open:**
   re-measure in the interactive TUI (which does appear to inject full descriptions), and the
   monolith-vs-modular delta on a representative task.
2. **Reliability of description-triggering.** — ✅ **MEASURED (pilot, N=3/domain).** Result:
   **unreliable and domain-dependent.** GraphQL (`.graphql`, distinctive signal) triggered the
   skill preventively **3/3** — *before* the first edit. But ordinary UI (`.tsx`) and API (`.ts`)
   edits triggered the standard **0/6** — the model went straight to `Read → Edit`, never invoking
   it. *Confirms §3.7:* description-only gating is a **soft** gate that silently misses common file
   types, so prevention-critical standards must load at **phase entry** (`sb-implement`) or via a
   deterministic hook, not by description alone. — ✅ **FIX VALIDATED (2026-07-04, N=5/domain).**
   The description arm replicated exactly (graphql 5/5 preventive; ui/api 0/10 → 0/16
   cumulative). The **phase-entry arm went 15/15 PREVENTIVE** with an identical chain in every
   trial (`Skill(entry) → Skill(domain) → Read → Edit`) — the §5.6 entry-skill + routing-table
   mechanism is deterministic in practice. **Still open:** cross-model confirmation
   (opus/haiku) only.
3. **Section-level loading.** ICM can load "section 3 of voice.md"; skills load a whole body. Is
   sub-document scoping worth building (e.g. a hook that extracts the matched section), or is
   module granularity fine-grained enough?
4. **Ordering / sequencing.** Skills are situational, not sequential. If phases genuinely need
   enforced order (research → implement → review with gates), evaluate lightweight ICM stage
   folders *inside* the worktree as a read-scoping convention (no chdir, per §3.3).
5. **How `sandbox-tools` actually installs skills.** Confirm the install path and whether
   sandbox ever appears as a workspace repo — this validates the content-in-body vs.
   pointer bet before committing to generation (step 4 of the spec build plan).
   **Sharpened by the 2026-07-04 gap review — this thread is now load-bearing:** the whole
   read-side rides on `sb-*` skills surfacing in sessions, but the user-scope plugin install
   is a *snapshot* — freshly generated skills in the repo reach no session until the plugin
   is refreshed, and nothing detects the drift. Planned fix: a version check at
   `sandbox init-workspace` (warn when the installed plugin's skills lag the repo's
   generated set). — ✅ **BUILT (2026-07-04):** `apps/cli/src/lib/plugin_check.ts` compares the
   install recorded in `~/.claude/plugins/installed_plugins.json` against
   `plugins/sandbox-tools/` — version lag as the headline, per-skill content diff
   (missing/stale/orphaned) as the backstop for same-version drift; warn-only, and
   silent (never a false alarm) when Claude's plugin state is absent or unreadable.
   Verified against the live machine: correctly flagged the v0.1.0 install missing
   all nine sb-* skills. Plugin manifest bumped to 0.2.0.
   — ✅ **RE-DECIDED same day (delivery moved to workspace projection):** the guard
   treated the symptom; the disease was user-scope delivery itself. The sb-* skills
   moved out of the plugin entirely — `init-workspace` now projects them into each
   workspace's `.claude/skills/` (standards skills rendered fresh from docs/standards/,
   entry skills from `infra/skills/`), so a standards edit reaches new workspaces with
   no marketplace/plugin step and no developer intervention. `sandbox skills check|sync`
   covers mid-feature staleness; sessions must start at the workspace root (documented
   convention). The plugin (v0.3.0) keeps only the sandbox-* ops skills; the version
   guard's surface shrinks to those. Decided with Jay: the workspace-root requirement is
   acceptable, and frequent low-friction standards updates outweigh plugin-snapshot
   stability. Spec §5.5 carries the full amendment.
6. **Generalize beyond standards.** The three-axis model (phase/domain/repo) and the
   compiled-routing-table pattern may apply to *any* JIT context — architecture docs, runbooks,
   test conventions, security checklists. Consider whether the routing table becomes the
   sandbox's general context-management control surface, not just a standards loader.
7. **Cross-agent portability.** Skills + hooks are Claude Code mechanisms. If other agents/tools
   run in these workspaces, does the `docs/standards/*.md` single source + a generic injection
   layer degrade gracefully? ICM's format-neutral doc layer is the hedge worth testing.

---

## 5a. Scope expansion (2026-07-03): from JIT *standards* to JIT *tools + specialized agents*

The design above gates **docs/standards** for a **single generalist agent**. A follow-on
exploration widened the goal to: *provide each agent, just-in-time, only the context **and tools**
it needs — where research, planning, coding, and testing agents each want a different toolset and
context, and each **service type** (a GraphQL subgraph vs. a UI package vs. a REST API) needs very
different context.* Two directions were decided in that session and are recorded here as threads
8–10; they **extend, not replace,** the three-axis model.

**Decisions taken (2026-07-03):**
- **A fourth axis — *tools* — is in scope** (thread #8).
- **Topology: the full subagent matrix** (thread #9, Option B). The sandbox generates
  per-workspace subagent definitions; specialization is real (tool-gated + isolated), not just
  advisory skill text.
- **The `standards:` field generalizes to a service `archetype`** bundling standards + MCP
  servers + tools + run/test commands + reference docs (thread #10).

**Decisions taken (2026-07-04) — the three open questions from threads 8–10, resolved:**
- **Orchestration: main agent as dispatcher, user-triggered phases** (see thread #9). Grounded in
  a hard mechanism fact: *subagents cannot talk to the user* — no AskUserQuestion, no mid-run
  checkpoint; only the main conversation loop can pause and ask. So human-in-the-loop (an explicit
  requirement) forces the orchestrator to be the main agent. Phases are user-invoked
  (`/sb-research`, `/sb-implement`); spawned subagents carry a **return contract** of
  *findings + a structured list of open questions/ambiguities*; the main agent surfaces those to
  the human **before** dispatching the next phase. No autonomous phase chaining. (Same shape as
  the GSD skills already in use — gather → ask → dispatch.)
- **Multi-archetype union rule: union MCP servers at the workspace, never union tools at the
  agent** (see threads #8/#10). Server connection is cheap to over-grant (schemas are deferred
  until ToolSearch), so `mcp_servers` unions across present archetypes with no cleverness. Agent
  `tools:` is what *defines* a specialist, so it is never union'd — one narrow specialist per
  present archetype. Cross-cutting changes (ui + graphql in one feature) are the **main agent's**
  job (full tools); specialists are for scoped work.
- **Migration: ship `standards:` now; `archetype` subsumes it, doesn't race it** (see thread #10).
  Spec build-plan steps 1–3 proceed unchanged. `archetype` is a strict superset with `standards:`
  as one field inside it; a bare service-level `standards: [ui]` normalizes to an anonymous
  archetype `{standards: [ui]}` in the loader, so both forms coexist with no flag day. The
  archetype's extra fields activate only when the subagent/tooling generator lands.

8. **The tool axis — the fourth gating axis.** The original model gates *context*; it never gates
   *tools*. A research agent wants `Read`/`Grep`/`Glob`/`WebSearch`/`context7`; a testing agent
   wants the test runner + browser/Playwright; a GraphQL agent wants schema introspection. Mechanism
   survey:
   - **Skills cannot gate tools** — a skill body can *suggest* tools but cannot grant or restrict
     them. Context-only. This is why the standards design alone can't satisfy the new goal.
   - **Subagent frontmatter (`tools:`) is the native per-agent tool allow-list** — the one
     primitive that bundles tools **+** context (system prompt) **+** isolation into a single
     gated unit. Precedent already in this environment: `Explore`/`Plan` are read-only subagents;
     `gsd-code-reviewer` ships a curated toolset.
   - **MCP tool schemas are *already* JIT** (deferred tools → `ToolSearch` loads a schema only on
     demand). So half the tool-cost problem is solved by the harness. The lever the **sandbox**
     controls is coarser and upstream: *which MCP servers even connect per workspace* (a GraphQL
     workspace mounts `context7` + a schema registry; a data workspace mounts its database MCP; a
     UI workspace mounts neither). That maps cleanly onto the archetype registry (thread #10).
   - **`permissions` allow/deny** in settings.json is a session-level coarse tool gate — a blunt
     backstop, not a per-phase mechanism.
   ~~*Open:* measure whether tool-gating changes agent behavior enough to justify the
   machinery.~~ ✅ **MEASURED (2026-07-04, harness 3, N=3/arm, sonnet).** Bait task
   (investigate-only prompt over a trivially fixable bug), disk hashes as ground truth:
   - **Un-gated, un-instructed main agent edited 3/3** — and, having "fixed" it, never
     delivered the requested findings (0/3 named the root cause). The strongest evidence yet
     that a research phase boundary is needed *at all*.
   - A "do not modify" instruction (3/3 clean), subagent role-framing alone (3/3, full tools),
     and the `tools:` gate (3/3) each eliminated edits. So at this N the gate is **not the
     behavioral differentiator** — its marginal value is converting *reliably behaves* into
     *cannot misbehave*. Since it costs one generated frontmatter line: defense-in-depth —
     role-framing for behavior, `tools:` for the guarantee.
   *(The union question is resolved — see the 2026-07-04 decisions above: union `mcp_servers` at
   the workspace, never `agent_tools` at the agent.)*

9. **Specialized-agent topology (the subagent matrix).** *Decided: Option B — generate
   per-workspace subagents.* The sandbox already knows the workspace's service composition
   (`services.yaml` + `_discover_repos()`), so the generator that emits the routing table (§5.3)
   also emits `.claude/agents/*.md`. Three design constraints keep this from exploding:
   - **Factor phase × archetype; don't cross-product.** *Phase gates tools; archetype gates
     context* — they are orthogonal, so **compose** them. Research and planning are read-only
     regardless of archetype → **one shared read-only agent each** (their only archetype-specific
     bit is which reference docs they're pointed at). Only implement/test/review specialize by
     archetype, and **only over archetypes present in the workspace**, never all known ones. A
     typical 2-archetype workspace generates ~5–7 agents, not 30.
   - **Skills nest *inside* subagents — the standards design is not superseded.** A subagent gets
     a fresh window but still sees the workspace `CLAUDE.md` routing table and can invoke the
     `sb-*-standard` skills. So archetype *context* still rides the skills mechanism from §5.5,
     now loaded **within** the implement subagent. The subagent adds only what skills can't: the
     **tool** gate and **context isolation**. Everything in §4 survives intact.
   - **Isolation is a benefit for research/test but a cost for implement.** Research's large
     read-only exploration not polluting the coding context is the win of a spawned subagent. But
     implement wants conversational continuity (the user watches and corrects), so implement may
     stay the **main agent** with tools union'd from present archetypes, rather than a
     handoff-walled subagent. "Full matrix" ≠ "every phase is spawned in isolation."
   ~~*Open:* who orchestrates phase transitions.~~ **Resolved 2026-07-04** (see decisions above):
   main agent as dispatcher, user-triggered phases, subagent return contract = findings + open
   questions, human consulted before each phase transition.

10. **Service `archetype` — one control surface for all JIT context + tools.** *Decided: design
    it.* Generalize the planned `standards: [ui, graphql]` field (§5.2) into a service `archetype`
    that bundles the whole profile:
    ```yaml
    next-hello:      { archetype: nextjs-ui }
    graph-gateway:   { archetype: graphql-subgraph }
    rest-hello:      { archetype: nest-api }

    archetypes:
      graphql-subgraph:
        standards:    [graphql]                         # existing axis (§5.1/§5.5)
        mcp_servers:  [context7]                          # tool axis — which servers connect (#8)
        agent_tools:  [Read, Edit, Bash, "mcp__context7__*"]  # subagent tools:  frontmatter (#9)
        reference:    [federation-composition.md, schema-introspection-runbook.md]
        run:          "npm run codegen && npm run dev"
        test:         "npm run test:contract"
    ```
    This makes the archetype the **single source** from which the generator projects *all* the
    surfaces: the routing table (§5.3), the domain skills (§5.5), the subagent definitions (#9),
    and per-workspace MCP-server enablement (#8). It is thread #6 ("generalize beyond standards")
    made concrete plus the tool axis (#8). The candidate archetype set mirrors the service
    taxonomy: `nextjs-ui`, `graphql-subgraph`, `nest-api`, `data` (airflow),
    `mcp-server`.
    ~~*Open:* migration and multi-archetype union.~~ **Resolved 2026-07-04** (see decisions
    above): `standards:` ships first and normalizes to an anonymous archetype (no flag day);
    union `mcp_servers` at the workspace level, never `agent_tools` at the agent level.

---

## 5b. Scope expansion (2026-07-04): structured notes — persistence across agents & sessions

Everything above is **read-side**: it decides what flows *into* a context window (standards,
tools, reference docs). Nothing manages what flows *out*. In ICM terms we adopted Layers 0–3
(router, contract, scoped reference) and skipped **Layer 4 — the working layer**. Three
boundaries lose context today:

| Boundary | What is lost | Current surface (and its defect) |
|----------|--------------|----------------------------------|
| **subagent → main agent** | the exploration bulk behind a returned summary; then the summary itself once compaction hits | the return message only — ephemeral by design |
| **session → session** (same workspace) | findings, settled decisions, tried-and-failed approaches | `## Handoff Notes` in the workspace CLAUDE.md — **a regenerated file**: `sandbox init-workspace` overwrites it wholesale (`_warn_if_existing` → "overwriting with fresh content"), violating the repo's own generated-files rule |
| **phase → phase** (HITL dispatcher, §5a) | research findings the implement/test phase needs later | main-agent context only |

Claude Code auto-memory does not cover this: it is scoped per *project path* (each ephemeral
workspace is a different path, so memory never follows a feature), subagents don't read it,
and it is Claude-Code-specific (fails the thread-#7 portability hedge). It solves
user/repo-lifetime *learning*; this expansion is about feature-lifetime *working state*.

**Decisions taken (2026-07-04):**
- **Handoffs belong in the notes layer.** The generated CLAUDE.md's `## Handoff Notes`
  section migrates to a *pointer* into the notes directory; durable state never again lives
  in a compiled projection.
- **Measure first.** Harness 4 (write/read contract compliance) runs before the companion
  spec is drafted — same discipline that produced the 15/15 phase-entry validation.
- **Teardown = print, don't exfiltrate.** `sandbox down` prints the latest `handoff` + open
  `decision` notes to the terminal before deletion; the human decides what graduates. No
  automatic writes to PR/Jira surfaces.

The companion [jit-context-system.md](jit-context-system.md) is now
drafted (2026-07-04, post-harness-4) — threads 11–13 below are the research trail behind it.

11. **The notes layer — write-side JIT (`.sandbox/notes/`).** *Proposed.* One directory per
    workspace, durable by construction (the generator never touches it — the same
    edit-surface precedent as `workspace.yml` `standards_override`). The workspace root is
    not itself a git repo, so `.sandbox/notes/` is the natural workspace-scoped home
    (committing notes inside one of N worktree repos would be arbitrary and PR-polluting).
    One note per file (`NNN-<type>-<slug>.md`), typed frontmatter:
    - `finding` — research-phase output: root cause, evidence, `file:line` refs.
    - `decision` — settled choices + why (the "don't re-litigate" contract, workspace-scoped).
    - `attempt` — tried-and-failed approaches; the most valuable and most-lost context.
    - `handoff` — phase/session transition state: done / in-flight / next / open questions.
    - `contract` — cross-repo interface changes (subsumes today's CLAUDE.md Handoff Notes).
    Frontmatter: `type`, `phase`, `author` (main agent vs. which subagent), `refs`
    (files/services), `status` (open/superseded). CLAUDE.md **points, never contains**: a
    routing-table row + the migrated Handoff-Notes pointer.
    *Open:* index mechanism — a compiled index (regen-coupled, can go stale between regens)
    vs. convention-read (`ls .sandbox/notes/` at phase entry; zero machinery, always fresh).
    Lean convention-read first; compile only if reads demonstrably miss.

12. **Wiring — return contracts write; entry skills read.** *Proposed.* The write and read
    sides attach to mechanisms that already exist:
    - **Write:** the agents-spec return contract (§4.2) gains a write side — the researcher
      *writes the full finding note* before returning, and returns the summary + note path.
      One move buys both isolation (bulk stays out of the main context) and persistence
      (survives compaction and session end). Handoff notes are written at pause/session end
      (a `sb-handoff` skill or a dispatcher step).
    - **Read:** the entry skills gain a step — `sb-research` checks prior `finding`/`attempt`
      notes before re-exploring; `sb-implement` loads `decision`/`contract`/`handoff` notes
      alongside the standards rows. Session start reads the latest `handoff`.
    ~~*Open (measure before trusting):* (a) does a return-contracted subagent actually write
    the note? (b) does a fresh session entering via the entry skill actually read the
    relevant note before acting?~~ ✅ **MEASURED (2026-07-04, harness 4, N=3/arm, sonnet).**
    - **Write contract: 3/3 compliance, 0/3 discipline breaches** — the contracted researcher
      wrote a well-formed finding note every trial and never touched source, even though the
      contract requires granting it `Write`. Without the contract: **0/3 spontaneous notes**
      — persistence never emerges, it must be contracted.
    - **Read side replicates the harness-2 pattern:** bare 0/3 (notes on disk are invisible),
      CLAUDE.md pointer 2/3 (soft gate), pointer + entry skill **3/3 read-before-edit** — the
      15/15 phase-entry mechanism generalizes from standards to notes.
    - **New failure mode: read-but-not-applied (1/3 in the entry arm).** The model read the
      binding decision note and still favored the prompt's "smallest correct change" over the
      note's mandate. Reading is deterministic; *application* competes with task framing →
      the entry skill needs conflict-precedence wording ("decision notes override
      minimal-change instincts; raise the conflict if you disagree"). Measure the fix at
      higher N before the spec freezes it.

13. **Scoping rule — feature-lifetime, with a graduation path.** *Proposed.* Notes die with
    the workspace (`sandbox down` / worktree teardown) — they are working state, not
    documentation. Knowledge that outlives the feature graduates *out* explicitly:
    per-repo quirks → `docs/standards/repos/*`, process lessons → auto-memory, contracts →
    the PR description. ~~*Open:* should `sandbox down` offer to exfiltrate the latest
    `handoff` + open `decision` notes instead of silently deleting them?~~ **Resolved
    2026-07-04:** print them to the terminal on `sandbox down`; the human graduates what
    matters. No automatic PR/Jira writes.

**Gap review (2026-07-04, pre-commit)** — a full pass over the feature-agent context
surface against the three specs surfaced three gaps and two scope calls, resolved as
follows:
- **Involuntary boundaries → hooks (folded into the notes spec, §4.5 there).** Notes
  writes/reads were all voluntary, but context dies involuntarily — at compaction and at
  fresh-session start (the harness-4 read arms invoked the entry skill explicitly; real
  users often won't). A `PreCompact` hook (refresh the handoff note before the squash) and
  a `SessionStart` hook (inject the latest handoff into the new window) close both, at zero
  standing cost. Unlike the rejected `PreToolUse` hook, neither guards a generation pass —
  they bracket window death and birth, so the too-late-to-prevent flaw doesn't apply.
- **Main-agent capture rule (folded into the notes spec, §4.3.3).** Implement runs in the
  main agent (HITL), which had no write trigger until session end — yet that's where
  decisions settle and attempts fail. `sb-implement` gains a capture-when-it-happens rule;
  provisional until compliance is measured (finding 2 warns in-body rules may under-fire).
- **Skill delivery/versioning (thread #5, sharpened above).** Version check at
  `init-workspace`.
- **Cross-workspace context: explicit NON-GOAL.** Parallel features touching the same
  service don't see each other's `contract` notes. Coordination across concurrent features
  is a human/k8s-mainline concern, not a workspace-context one — declared out of scope
  rather than left looking like a hole.
- **Inbound external-context staleness: DEFERRED.** The Jira ticket is captured once at
  workspace creation; mid-feature ticket updates and PR review feedback re-enter only via
  the human. Acceptable for now; revisit if stale-ticket confusion shows up in real
  sessions.

---

## 6. References

- **ponytail** — https://github.com/DietrichGebert/ponytail (plugin: single-source rules synced
  across surfaces + turn-boundary hook injection + `/ponytail lite|full|off`).
- **ICM (Interpretable Context Methodology)** — layered context loading (Layer 0/1 router ≈ 800
  tok; Layer 2 contract + Inputs table; Layer 3 scoped reference; Layer 4 working). Figure 3's
  ~5k focused vs. ~42k monolithic is the token pitch.
- **Companion spec:** [jit-context-system.md](jit-context-system.md).
- **Source discussion:** design session 2026-06-29 (Claude Code session
  `77b3bcbb-ad16-41a1-bc2c-33e26e25caa8`).

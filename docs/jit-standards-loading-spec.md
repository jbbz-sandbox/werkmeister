# Just-in-Time Code Standards Loading — Design Spec

> **Status:** Proposal / design-only. No code written yet. This document is the handoff
> for an implementer (human or agent).
> **Author:** design session, 2026-06.
> **Scope:** sandbox. Affects `docs/`, `infra/config/services.yaml`,
> `apps/cli/src/commands/init_workspace.ts`, and `plugins/sandbox-tools/skills/`.

## 1. Summary

Today every sandbox workspace gets an always-on `CLAUDE.md` that links to a single
monolithic `docs/code-style-guide.md`. Nothing is scoped to the workspace's repos, the
work being done, or the phase. This spec replaces that with a **just-in-time (JIT)
standards system**: the canonical standards are split into small modules, surfaced as
Claude Code skills that load only when the work matches, scoped to each ephemeral
workspace's actual repo combination by a registry in `services.yaml`, and made
inspectable through a single generated routing table in the workspace `CLAUDE.md`.

The design is the synthesis of two references:
- **ICM** (Interpretable Context Methodology, arXiv:2603.16021) — layered context loading
  and an inspectable Layer-1 routing table. We borrow the *loading principle*, not the
  stage-pipeline workflow.
- **ponytail** (github.com/DietrichGebert/ponytail) — single-source rule text synced
  across surfaces + lifecycle-hook injection + a decision-ladder ruleset. We borrow the
  *architecture*, and we *install the plugin itself* as part of the universal coding base (§5.8).

## 2. Goals / Non-Goals

**Goals**
- Introduce high-level code standards to agents **just in time** — only when relevant.
- **Conserve tokens**: nothing irrelevant in the always-on context window.
- Work for **ephemeral workspaces with any combination of repos**.
- Gate standards by **domain** (GraphQL / UI / API / data) and **phase** (research vs. coding).
- Keep a **single inspectable control surface** for "what loads when" (the ICM property).
- Single source of truth per standard; no copy-paste drift.

**Non-Goals**
- Not building an ICM stage-folder pipeline (`01_research/`, `02_implement/`). The phase
  gate is achieved by skill triggers + an entry command, not directories.
- Not reimplementing ponytail. If its decision-ladder is wanted, install the plugin.
- Not changing how services run, ports, Caddy, or compose generation work.

## 3. The conceptual model

Every piece of standards context is gated on one or more of three independent axes:

| Axis | Question | Mechanism |
|------|----------|-----------|
| **Phase** | research vs. coding vs. review | skill trigger wording + `sb-implement`/`sb-research` entry skills |
| **Domain** | GraphQL? UI? API? data? | one skill per domain, gated by its `description` |
| **Repo presence** | which repos are in this workspace? | `standards:` field in `services.yaml` → generated routing table |

**Why skills:** a Claude Code skill's `name + description` is in context for the whole
session (cheap, ~20–50 tokens each), but its **body** — the actual rules — loads only when
invoked. That lazy body is the JIT win. A skill is effectively *ICM's Layer 1 routing entry
fused with its Layer 2/3 payload*, with routing made automatic via description-matching.

**Why an explicit routing table on top:** automatic matching loses ICM's single inspectable
"what loads when" map. We recover it by generating a small routing table into the workspace
`CLAUDE.md` (ICM Layer 1) compiled from `services.yaml`. The skills carry content; the table
is the inspectable, governed map.

**Token framing (ICM Fig. 3):** the target is ~2–8k focused tokens per stage instead of a
monolithic ~40k. Always-on cost stays near today's (one small routing table + N short skill
descriptions); rule bodies enter context only on matching work.

## 4. Architecture / data flow

```
docs/standards/*.md          ← single source of truth (one file per standard module)
        │  (generation / sync)
        ├──────────────► plugins/sandbox-tools/skills/tr-*-standard/SKILL.md   (the payloads)
        │
infra/config/services.yaml   ← `standards:` per service (the wire: repo → domains)
        │
        ▼  (sandbox workspace / init-workspace)
workspace/CLAUDE.md "Standards routing" block   ← compiled Layer-1 table (inspectable)
        ▲
.sandbox/workspace.yml `standards_override:`     ← per-workspace edits (durable)
        │
        ▼  (agent at coding time)
sb-implement reads the table → loads sb-comments-standard + matching domain skills (JIT)
```

Edit surfaces (ICM "configure the factory"): defaults in `services.yaml`; per-workspace in
`.sandbox/workspace.yml`. The `CLAUDE.md` block is a **compiled projection — never hand-edited**
(consistent with the repo rule that generated files are regenerated on `sandbox up`).

## 5. Components

### 5.1 `docs/standards/` — decompose the monolith (single source of truth)

> **Superseded naming (2026-07-17):** the `api` and `graphql` modules shown below were
> later **folded into a single `service` domain** (REST + GraphQL federation/Relay, plus
> resilience / contract-evolution / performance) by the service-merge work — see
> `docs/superpowers/specs/2026-07-17-service-config-auth-domains-design.md` and
> `docs/jit-README.md` for the current domain set. GraphQL rules are alive as the
> `### GraphQL` subsection of `sb-service-standard`, not a standalone domain. The
> `graphql`/`api` examples in this section and §5.5 are kept as the original design record.

Split `docs/code-style-guide.md` into one file per concern. Each file carries frontmatter
used by the generator and the optional hook.

```
docs/standards/
  comments.md      # today's shared "comments explain why not what" rubric (the universal base)
  graphql.md       # federation @key rationale, cursor semantics, N+1/dataloader, nullability, Typesense
  ui.md            # render/effect ordering, hydration, CDN cache-key versioning
  api.md           # (placeholder) REST/Nest contract conventions
  data.md          # (placeholder) Airflow/scheduling/epoch-ms quirks
  repos/           # per-repo "which quirks matter here" snippets (current Per-repo notes section)
    econx.md  comx.md  sb-web.md  taxonomy-service.md  ...
```

Frontmatter schema (per standard module):

```yaml
---
domain: graphql                 # the standard's key, matches services.yaml `standards:`
applies_to:                     # globs — consumed by the optional hook + the routing table
  - "**/*.graphql"
  - "**/*.gql"
  - "**/resolvers/**"
phase: [implement, review]      # phases in which this loads; omit research
summary: One-line description used to seed the skill description.
---
```

`docs/code-style-guide.md` becomes a thin index that links to the modules, preserving the
existing canonical GitHub URL referenced from CLAUDE.md.

**Acceptance:** all content in today's 155-line guide is preserved, relocated, no rules lost;
`comments.md` = the universal rubric; per-repo notes live under `repos/`.

### 5.2 `services.yaml` — the registry wire

Add an optional `standards:` list to each service. Example:

```yaml
services:
  web-v2:          { repo: econx, path: apps/web-v2, ...,  standards: [ui] }
  interview-api:   { repo: econx, ...,                      standards: [graphql] }
  federated-graph: { repo: econx, ...,                      standards: [graphql] }
  category-api:    { repo: comx,  ...,                       standards: [api] }
  # services with no standards key contribute only `comments` (the universal base)
```

`comments` is implicit/universal and need not be listed. Values must match a
`docs/standards/<key>.md` `domain:`.

**Acceptance:** loader validates each `standards:` entry resolves to a standards module;
unknown key → clear error at `sandbox workspace` time.

### 5.3 Generated routing block in `CLAUDE.md` (ICM Layer 1, inspectable)

`init_workspace.ts:_build_claude_md()` (~line 1066) gains a section. For a workspace with
`web-v2` + `interview-api` (repo: econx):

```markdown
## Standards routing
> Compiled from services.yaml + .sandbox/workspace.yml. Don't hand-edit — see the spec.

**Active in this workspace** (repos: econx):

| Standard | Skill                  | Loads on                              |
|----------|------------------------|---------------------------------------|
| comments | `sb-comments-standard` | any code edit                         |
| ui       | `sb-ui-standard`       | *.tsx, components (web-v2)             |
| graphql  | `sb-graphql-standard`  | *.graphql, resolvers (interview-api)  |

Not active (no matching repo): api, data — do not load.

**By phase:**

| Phase               | Load                                            | Skip                          |
|---------------------|-------------------------------------------------|-------------------------------|
| research / planning | nothing below — read & reason only              | all code standards            |
| implementing        | `comments` + the row matching the file you edit | standards for untouched files |
| review              | the standards covering files in the diff        | —                             |
```

Resolution algorithm (generator):
1. Determine repos in workspace (existing `_discover_repos()`).
2. Union the `standards:` keys of the workspace's **selected services** (its `services`
   field — the declared intent). Fall back to all services of the workspace's repos only
   when no services are selected. *(Amended 2026-07-04 during implementation: monorepos
   like econx span ui/graphql/api, so a repo-level union would activate everything for
   every econx workspace and violate the acceptance case below; the service selection is
   the correct signal, `standards_override.add` the escape hatch.)*
3. Apply `.sandbox/workspace.yml` `standards_override` (`add` / `remove`).
4. Always include `comments`.
5. Render the Active table from active modules' frontmatter (`applies_to` → "Loads on" hints);
   render Not-active for the remaining known modules.

**Acceptance:** a `web-v2`-only workspace shows `comments, ui` and lists graphql/api/data as
not active; a `category-api`-only workspace shows `comments, api`. Block regenerates on `up`.

### 5.4 `.sandbox/workspace.yml` — per-workspace override (durable edit surface)

```yaml
standards_override:
  add: [api]        # force-load even without a matching repo (e.g. touching a contract)
  remove: [graphql] # suppress for this workspace
```

Read by the generator in step 3 above. This is the human edit surface that survives regen.

**Acceptance:** override is honored and reflected in the regenerated routing block.

### 5.5 Domain standard skills (generated from `docs/standards/`)

One skill per module under `plugins/sandbox-tools/skills/`. Generated, not hand-authored, so
the standards doc stays the single source. Template (GraphQL shown):

```markdown
---
name: sb-graphql-standard
description: >-
  Sandbox GraphQL coding standard. Use when EDITING OR IMPLEMENTING GraphQL —
  federation subgraph schemas, @key directives, resolvers, .graphql/.gql files,
  supergraph config, or pagination/cursor code. Not during research/planning or
  for non-GraphQL edits.
---

# GraphQL standard

The shared comment rubric applies in full (see `sb-comments-standard`). Below are only the
GraphQL-specific cases where a comment is earned, plus this codebase's idioms.

## What justifies a comment
- Federation @key ownership/rationale (which subgraph owns vs. extends)
- Pagination/cursor semantics and boundary behavior
- Resolver fan-out / N+1 and deliberate non-batching
- Nullability as a contract choice (tolerating a flaky upstream)
- External-system quirks (Typesense filter injection — keep in sync with web-v2 sanitizeFilterValue)

## Idioms
<curated examples, copied from docs/standards/graphql.md>

## Before you write
Could a competent reader infer this from the schema + types alone? If yes, fix the
name/type. If no, write the shortest comment that closes the gap.
```

Design rules:
- **Description is the gate.** It encodes domain + phase ("when editing/implementing… not
  research"). The body never loads during read-only research.
- **Body does not restate** the shared rubric — it references `sb-comments-standard` and
  carries only the domain delta (keeps bodies small / ICM Layer 3 scoped reference).
- Body content is generated from the matching `docs/standards/<domain>.md` (single source).
  A check script (ponytail-style) verifies skill bodies match their source doc.

Skills to generate: `sb-comments-standard` (universal), `sb-graphql-standard`,
`sb-ui-standard`, `sb-api-standard`, `sb-data-standard`.

**Acceptance:** editing a `.graphql` file in a coding session pulls `sb-graphql-standard`;
a research/planning turn does not; skill body byte-matches `docs/standards/graphql.md` content.
*(Amended 2026-07-04 during implementation: the body is the doc body with relative links
rewritten — sibling-module links become skill references, other relative links become
canonical GitHub URLs — because doc-relative paths dangle in workspaces (decision 1's own
rationale). "Byte-match" is therefore enforced as regeneration-match: `sandbox standards
check` / `apps/cli/src/lib/__tests__/skill_gen.test.ts` fails on any difference from a fresh render.)*

**Delivery amended 2026-07-04 (workspace projection, replacing plugin delivery):** the
tr-* skills are no longer shipped through the user-scope `sandbox-tools` plugin. Instead
`init-workspace` **projects** them into each workspace's `.claude/skills/` — the five
standards skills rendered on the fly from `docs/standards/` (no committed generated
copies exist anymore; `sandbox standards build|check` and the repo-level drift gate are
retired, since generation at the point of use cannot drift), and the four hand-authored
entry skills copied verbatim from `infra/skills/`. Rationale: user scope surfaced nine
Sandbox-workspace-only skills in every session everywhere, and — worse — made skill
delivery lag the repo behind a manual marketplace/plugin refresh (thread #5's whole
problem). Projection scopes them JIT-correctly and lets standards edits reach new
workspaces with zero developer intervention. Consequences: **sessions must start at the
workspace root** (project skills, like the workspace hooks, resolve from the session's
project directory — a documented convention, not enforced); mid-feature staleness is
handled by `sandbox skills check` (exit-1 report) / `sandbox skills sync` (refresh),
with re-init also refreshing. The plugin (v0.3.0) keeps only the globally useful
`sandbox-*` ops skills; the thread-#5 version guard now covers just those.

### 5.6 Phase entry skills (deterministic phase control)

Two thin skills that make the phase explicit and read the routing table rather than carrying
the mapping themselves (keeps routing in one place):

```markdown
---
name: sb-implement
description: Begin the implementation/coding phase in a sandbox workspace. Use when starting
  to write or edit code after research/planning.
---
1. Read the "Standards routing" block in CLAUDE.md.
2. Load the universal coding base FIRST, before writing any code: `sb-ponytail`
   (decision-ladder / minimal-code) + `sb-comments-standard`. These must be in context
   before the first generation pass — see §5.9.
3. Then load every Active row whose "Loads on" matches the files you edit. Ignore Not-active rows.
4. Re-check on each new file type you touch.
```

```markdown
---
name: sb-research
description: Begin the research/planning phase. Use when exploring the codebase or planning an
  approach before writing code.
---
Do not load any code standards. Read, search, and reason only. Switch to sb-implement before editing.
```

**Acceptance:** `/sb-research` loads no standards; `/sb-implement` loads exactly the active +
file-matching set.

### 5.7 Optional deterministic backstop — glob hook

If description-triggering proves unreliable, add a `PreToolUse(Edit|Write)` hook (settings.json)
that reads modules' `applies_to` globs and injects a one-line pointer ("↳ sb-graphql-standard
applies") on a matching edit. **Zero standing context cost** (harness-run; not in the model
context until it fires). Defer until proven necessary.

### 5.8 ponytail — part of the universal coding base

ponytail's decision-ladder ("does this need to exist? already in the codebase? stdlib?…") is
the *most important* rule when editing code, so it loads alongside `sb-comments-standard` as the
universal base whenever the coding phase begins — not as an optional add-on. Install it as a
plugin (`/plugin marketplace add DietrichGebert/ponytail`) and reference it from `sb-implement`
as `sb-ponytail`; do not reimplement it. *(Amended 2026-07-04: the plugin's real skill name is
`ponytail`, not `sb-ponytail` — `sb-implement` references it by its real name, with a graceful
"say so once and continue" fallback when the plugin isn't installed.)*

**Timing is critical for ponytail** (see §5.9): its value is *prevention before writing*, so it
must be in context before the first code-generation pass. That means it loads at **phase entry**
(`sb-implement`), never via a `PreToolUse(Edit)` hook — a hook fires only after the model has
already drafted the code, by which point a decision-ladder has nothing left to prevent.

### 5.9 Loading timing — why prevention rules load at phase entry, not on the edit event

The mechanism that loads a standard determines *whether it can influence the first draft*:

| Mechanism | Fires | Effect on first code pass |
|-----------|-------|---------------------------|
| `sb-implement` / phase-entry invocation (or a UserPromptSubmit/SessionStart hook) | before the model generates | **In context for the first pass — can prevent.** |
| Skill description match ("use when editing…") | usually before the edit, at the model's discretion | Often prevents, but not guaranteed — the model may start writing before it invokes the skill. |
| `PreToolUse(Edit\|Write)` hook | after the model emits the Edit/Write call, before it hits disk | **Too late to prevent.** The code is already drafted in the tool arguments; the hook can only inject feedback that triggers a *revision* pass. |

Key point: a `PreToolUse(Edit)` event happens **after** the first LLM code pass — the generated
code is literally the tool-call input by the time the event fires. So "load on the edit event"
is reactive (review/refactor), not preventive. For `sb-comments-standard` that is tolerable
(comments can be cleaned up after a draft). For `sb-ponytail` it is not — a decision-ladder that
runs after the over-engineered code exists has already lost. Therefore the universal base
(`sb-ponytail` + `sb-comments-standard`) loads at **phase entry**, before any code is written.

## 6. Build plan (sequenced, each independently shippable)

1. **Decompose docs** (§5.1). Pure content move + frontmatter. No behavior change. Lowest risk.
2. **Registry** (§5.2). Add `standards:` to `services.yaml` + loader validation. No output change yet.
3. **Routing block** (§5.3, §5.4). Generator emits the table from steps 1–2; honor override.
   This alone delivers an inspectable map even before skills exist.
4. **Domain skills + generator/sync + check script** (§5.5). Now bodies load JIT.
5. **Phase entry skills** (§5.6) + install ponytail and wire `sb-ponytail` into the universal
   coding base loaded by `sb-implement` (§5.8).
6. **(Optional)** glob hook backstop (§5.7) — only for review-tolerant standards (§5.9).

Steps 1–3 are valuable on their own; 4 delivers the JIT loading; 5 adds phase determinism.

## 7. Decisions (recommended)

The four points below were open during design; each now carries a recommendation. They can
be overridden, but the spec assumes these answers.

1. **Skill body = content, not pointer. → Recommend content-in-body.**
   *Why:* skills install globally (the `sandbox-tools` plugin), so a content-bearing body
   works in *any* ephemeral workspace regardless of repo combination. A "Read
   docs/standards/x.md" pointer only resolves when sandbox itself is a workspace
   repo — which is rarely the case — so it would silently fail for normal feature work.
   Content-in-body costs more skill bytes but they are still lazy-loaded (JIT), so there is
   no always-on penalty. Single-source integrity is preserved by decision 2, not by pointing.

2. **Generate skills from `docs/standards/`; do not hand-author. → Recommend a thin generator
   + check script.**
   *Why:* two hand-maintained copies (the doc and the skill body) guarantee drift; a check
   script alone only *detects* drift after it happens and adds review friction. A small
   generator (`sandbox standards build` or a pre-commit step) that emits each `SKILL.md` from
   its `docs/standards/<domain>.md` (frontmatter `summary` → description seed, body → body)
   makes the doc the unambiguous single source. Keep the check script too, run in CI, to fail
   the build if a `SKILL.md` is edited out of sync. For the current ~5 modules the generator
   is a few dozen lines — cheaper than the drift it prevents.

3. **`comments` loads on any code edit, never during research. → Recommend confirmed as
   written.**
   *Why:* the comment rubric governs *writing* comments; it has no bearing on reading or
   planning. Loading it during research spends always-relevant tokens on a read-only phase
   for no benefit and weakens the phase gate. It loads via `sb-implement` (and on the first
   code edit), which is exactly when it applies.

4. **Ship without the glob hook; revisit only if triggering misses. → Recommend defer.**
   *Why:* the hook (§5.7) is a deterministic backstop for a problem we have not observed yet.
   Adding it upfront is speculative machinery. Ship steps 1–5, watch real sessions for a
   week or two, and add the hook only if a standard demonstrably fails to load on matching
   edits. Its zero standing-context cost means it can be added later with no redesign.
   *Caveat (§5.9):* a `PreToolUse(Edit)` hook fires after the first draft, so it can only ever
   back up review-tolerant standards (comments), never prevention rules (`sb-ponytail`) — those
   load at phase entry regardless.

## 8. References
- ICM: Interpretable Context Methodology, arXiv:2603.16021 — Layer model (Fig. 1), routing
  table (Layer 1), Inputs-table contracts (§3.3), token composition (Fig. 3).
- ponytail: github.com/DietrichGebert/ponytail — single-source rule sync, lifecycle-hook
  injection, level command.
- Current state: `docs/code-style-guide.md`; `init_workspace.ts:_build_claude_md()` (~L1066);
  `infra/config/services.yaml`; `plugins/sandbox-tools/skills/`.
```

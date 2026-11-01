# JIT Context System

Just-in-time context for ephemeral Werkmeister workspaces: coding standards, tools, and working
notes surface **only when the work matches** — scoped to the workspace's actual services and
the current phase — instead of one always-on monolithic guide.

This is the single current-state document for the system. It describes what is built, not how
it got here.

## 1. Goals

1. **Just-in-time standards** — deliver standards to agents only when relevant, never as an
   always-on preamble.
2. **Token conservation** — minimal standing footprint; pay for context at the moment of use.
3. **Phase awareness** — research, implement, test, review, and PR each load different context.
4. **Domain and service awareness** — UI standards only on UI work, and only in workspaces
   whose services actually contain that domain.
5. **Cheap-model enablement** — with the right context at the right moment, a less capable
   model completes work it would otherwise fail (measured: harness-6, Haiku 4.5, 9/9 applied
   with standards loaded vs 0/9 control).

## 2. Design model

Four gating axes, each wired to its natural mechanism:

| Axis | Mechanism | Resolution time |
|------|-----------|-----------------|
| **Phase** (research/implement/test/review/pr) | Phase-entry skills (`w9r-implement`, …) + a compiled routing table in the workspace `CLAUDE.md` | runtime, model-invoked |
| **Domain** (ui/service/data/auth/config/testing/observability) | Generated `w9r-<domain>-standard` skills; `applies_to` globs matched against the files being edited | runtime, model-invoked + hook-enforced (§6) |
| **Service presence** | `services.yaml` archetypes → standards keys, resolved per workspace at init | init time, deterministic |
| **Tools / isolation** | Generated subagents with `tools:` allowlists | init time, deterministic |

Governing principles (each anchored to an internal measurement; the harnesses are not published):

- **Map, not territory.** The workspace `CLAUDE.md` carries a compiled routing *table*, never
  standard bodies. Bodies live in skills and load on demand. (Harness-1: skill descriptions
  cost ~3–7 standing tokens each; bodies are fully lazy.)
- **Phase entry beats description-gating.** Model-side description matching collapses for
  common file types (harness-2: 0/16 trigger for ui/api). The deterministic chain — routing
  table names the entry skill, entry skill loads the standards — measured 15/15 preventive.
- **Prevention requires pre-generation loading.** Rules must be in context before the first
  code draft. An `Edit`/`Write` hook fires *after* drafting — by then the code is already in
  the tool-call payload, so a hook can only trigger a revision pass, never prevent (§6).
- **Precedence is the causal compliance lever.** Rule content alone loses to conflicting task
  framing (harness-5: Haiku 0/3→3/3 with the precedence block; harness-7: enriched rule
  summaries without precedence still 0/3). Every delivery path carries the
  invariant/rule/nit framing, not just the rules.
- **Persistence must be contracted.** Agents never write durable notes spontaneously
  (harness-4: 0/3 uncontracted vs 3/3 contracted). Every note-producing behavior is an
  explicit instruction with a format.
- **Subagent tool gates convert "reliably behaves" into "cannot misbehave"** (harness-3).

## 3. Content model — the standards tree

Single source of truth for all standards content, in its own repo
([jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards)), resolved through `overrides.standards_dir` <!-- name-check: ignore -->
in `~/.werkmeister/config.yaml` — the CLI is the machinery, the tree is an org's content.
Defaults to `<werkmeister root>/docs/standards` when unset, which no longer exists in this
repo, so an unconfigured install resolves zero modules. Loader:
`packages/werkmeister-core/src/standards.ts::loadStandardsModules`. Two recognized shapes:

- directory: `<domain>/STANDARD.md` (+ optional `references/*.md`)
- flat: `<key>.md`, where `<key>` is lowercase kebab (so a `README.md` at the tree
  root is not mistaken for a module)

Domains come from the configured standards repo; the loader resolves none when it is
unset. An example set, in directory form:

| Domain | Covers |
|--------|--------|
| `comments` | Universal "comments explain the why, not the what" rubric |
| `engineering` | Cross-cutting constraints — architectural fit, reversible change, performance budgets, reviewable PRs |
| `service` | Service-boundary contracts — API conventions, contract evolution, cross-service resilience |
| `config` | Inter-service URL/DNS conventions and env-var rules |
| `auth` | Token audiences and scopes, session cookie scope |
| `testing` | Unit vs integration vs contract tests; what to mock at a service seam |
| `observability` | Tracing and structured-logging conventions, correlation-ID propagation |
| `data` | Pipeline ordering and scheduling, timestamp conventions |
| `ui` | Render/effect ordering, hydration, caching |

`repos/*.md` are per-repo quirk snippets keyed by `repo:`, referenced from
standard bodies. They are **not** loadable standards.

### 3.1 Frontmatter schema

Enforced by `validateStandardModules`:

```yaml
---
domain: ui                 # required; MUST equal the directory name / file stem
summary: One-line summary. # required; feeds skill description + routing table + re-inject block
applies_to:                # required; non-empty list of globs — the file gate
  - "**/*.tsx"
  - "**/components/**"
phase: [implement, review] # optional; MUST be a list if present; default [implement, review]
task_signatures:           # optional; case-insensitive substrings matched against task text (§4.3)
  - "federation"
  - "apollo gateway"
---
```

### 3.2 Body conventions

- Rules are concise prose under `## Rules` plus `## Don't` bullets. The anti-pattern
  one-liners double as the review checklist.
- `references/<name>.md` files (directory form only) hold war stories and deep dives. Each
  must be linked from its STANDARD.md index, and each `ap-*.md` (anti-pattern) reference must
  additionally have an inline don't-line bullet linking to it — enforced by
  `validateModuleReferences`. A reference may carry a `canonical: <repo>:<path>` frontmatter
  pointer to an exemplar file; when present it renders as a "Full file" link footer, and the
  literal placeholder `canonical: TODO` is rejected.
- **Authoring / graduation flow:** review findings become `decision` notes; `werkmeister notes
  graduate` scaffolds a standard entry with `TODO(graduate)` markers; the `w9r-author` skill
  fills them; the validator blocks committing unfilled markers.
  Eligibility is computed from *content shape* — a STANDARD.md carrying both `## Rules` and
  `## Don't` (`packages/werkmeister-core/src/graduate.ts::eligibleDomains`), not a fixed list.

### 3.3 Universal standards

`UNIVERSAL_STANDARDS = ["comments", "engineering"]` (`packages/werkmeister-core/src/standards.ts`). Tuple
order is semantic (base first). Universals are always active in every workspace, ungated by
file type (`applies_to: ["**/*"]`), never listed in any archetype's `standards:`, loaded at
implement-phase entry, and always included in post-compaction re-injection when anything
changed.

## 4. Resolution semantics

### 4.1 Workspace activation (init time) — `resolveActiveStandards`

The registry is `~/.werkmeister/services.yaml`, whose `archetypes:` block is the single control
surface. An archetype bundles what a service *type* contributes to a workspace:

```yaml
archetypes:
  node-web:
    standards:   [ui, config, testing]   # → routing table + generated skills
    mcp_servers: [context7]              # → .mcp.json union
    test: "npm test"                     # → w9r-tester-<archetype> ({service} expands)

services:
  backend: { repo: werkmeister, archetype: node-web, ... }
```

Resolution:

```
services.yaml:  repos.<repo>.services  →  service.archetype  →  archetypes.<name>.standards
```

1. Candidate services = the workspace's **selected** services (declared intent) if any, else
   the union of services across the workspace's repos. Selected-wins matters for monorepos: a
   repo spanning ui+graphql+api would otherwise activate everything for every workspace.
2. Union each candidate service's archetype `standards:` keys. A legacy bare `standards: [ui]`
   on a service is normalized into an anonymous archetype by
   `packages/werkmeister-core/src/archetypes.ts` — both forms coexist.
3. Apply `.werkmeister/workspace.yml` `standards_override: {add: [...], remove: [...]}` — the
   durable per-workspace edit surface that survives regeneration.
4. Add `UNIVERSAL_STANDARDS`; intersect with modules that actually exist.
5. Output `(active, notActive)`, universals first in tuple order.

A service's own `test:` overrides its archetype's template
(`archetypes.ts::serviceTestCommand`) — the test command is a property of the repo's tooling,
which an archetype default cannot always know. All commands run from the service's repo root
inside the workspace.

### 4.2 Diff matching (runtime) — `standardsMatchingDiff`

Changed paths = (merge-base vs `origin/main`|`main` diff) ∪ uncommitted (`git status
--porcelain`), unioned across every git repo/worktree directly under the workspace root.
Each non-universal module matches if any changed path fnmatches any `applies_to` glob;
universals append whenever anything changed. The git layer is best-effort with a 5s timeout
and never raises — it feeds a session-launch hook.

Known accepted limitation: `fnmatch` keeps `/` literal, so repo-root files under-match
`**/*.x` globs. Worst case is one standard not re-injected.

### 4.3 Task-text matching — `domainsMatchingTaskText`

Distinct from the edit-time gate, and it fires *earlier*. The workspace's starting prompt
names libraries and concepts up front ("federation", "RemoteGraphQLDataSource"), so a domain
the service selection did not imply gets surfaced **before any code is authored** — the window
the gate structurally misses, since a `Write` payload already contains the drafted file.

Case-insensitive substring match of each module's `task_signatures` against the task text. A
coarse net at the gate's altitude, deliberately not an import parser.

### 4.4 Precedence tiers

The behavioral contract, carried by every delivery path (entry skills, generated skill
footers, the re-injection block, and the gate's deny reason). When a loaded standard conflicts
with the task's framing, resolve by the rule's own weight:

- **Invariant** (must-never rule): the standard wins. Apply it, write a `decision` note, do
  not proceed against it even if the task asks. In review: blocking finding.
- **Rule** (normal STANDARD.md rule): surface the conflict in one line, apply the standard,
  continue. In review: raise, let the author respond.
- **Nit** (style/anti-pattern one-liner): apply silently, tag `phase: review`. In review:
  optional/low-severity.

`decision` notes are binding over task-level instincts; a conflict between a decision note and
the task as given is raised to the user, never silently resolved.

## 5. Delivery artifacts

These artifacts are written by the `jit` context strategy (`packages/werkmeister-core/src/strategies/jit.ts`); `context_strategy: jit` in `workspace.yml` selects it (the default for new workspaces is `icm`).

Everything below is **generated or copied into the workspace** at `werkmeister workspace init` —
nothing is distributed through a plugin. Projection scopes the skills to the sessions they
apply to and kills plugin-refresh lag: init renders fresh from this repo, so a standards edit
reaches new workspaces with no marketplace step. The `werkmeister` plugin keeps only the
globally useful ops skills. Standards skills are projected only for the workspace's
active set (§4.1): a skill that is not there cannot be loaded, so the routing table carries no
"do not load" list.

Consequence: **sessions must start at the workspace root** — project skills and hooks resolve
from the session's project directory. Freshness mid-feature is self-healing: the SessionStart
hook runs `werkmeister skills check` and, only when it reports drift, `werkmeister skills sync`.

### 5.1 Generated domain skills — `.claude/skills/w9r-<domain>-standard/`

Rendered on the fly from the standards tree by `packages/werkmeister-core/src/skill_gen.ts`:

- `description:` is the composed trigger gate: `Werkmeister <summary> Use when EDITING,
  IMPLEMENTING[, OR REVIEWING] <domain> code — files matching <applies_to globs>. Not during
  research/planning, and not for edits outside this domain.` (verbs derived from `phase:`).
- Body = the STANDARD.md body with links rewritten: sibling-module links become skill
  references; other relative links become canonical GitHub URLs on the repo's default branch
  (`GITHUB_REPO_BASE` + `GITHUB_BRANCH = "main"`); `references/` links pass through, since the
  bundle keeps references adjacent.
- Body ends with a **precedence footer**, so any load path re-establishes precedence — not
  just `w9r-implement`.
- Directory-form references project as `references/<name>.md` beside the SKILL.md, loaded only
  on suspicion of the specific anti-pattern.
- A generated do-not-edit header names the source file and the sync command.

### 5.2 Hand-authored entry skills — `apps/cli/infra/skills/*/SKILL.md`, copied verbatim

| Skill | Phase | What it loads / does |
|-------|-------|----------------------|
| `w9r-research` | research/planning | loads nothing; establishes scope, givens and deliverable shape with the user; spawns the read-only `w9r-researcher` agent, which carries the investigation method. `w9r-research` ends by work type: architectural work ends in a `decision` note with `status: decided` written only on the user's explicit approval, bounded work in a `finding` naming the root cause, a spike in findings only. |
| `w9r-implement` | coding | universal base (`ponytail` plugin + comments + engineering) at entry; reads routing table + notes; loads Active-row standards matching files about to be edited; re-checks per new file type; recitation rule (restate the governing rule at the edit); output-redirect rule (pipe verbose check output to a file, read back only failures); capture-as-you-go notes contract; precedence tiers |
| `w9r-test` | testing | loads nothing; spawns `w9r-tester-<archetype>` agent(s), which run the unit tests and a guarded proxy smoke check; names the plugin's `werkmeister:feature-test` skill for headed browser runs |
| `w9r-review` | review | universal base + standards covering files in the diff; inline anti-pattern one-liners are the checklist; decision-note violations are findings; precedence tiers as severity ladder |
| `w9r-pr` | finishing | pre-PR gate, then `w9r-review` |
| `w9r-handoff` | any boundary | writes the structured handoff note |
| `w9r-author` | authoring | fills graduation scaffolds in the standards tree |

### 5.3 Workspace `CLAUDE.md` — the compiled routing table

`packages/werkmeister-core/src/harness/claude/claude_md.ts::buildStandardsRoutingSection`. The "Standards routing" section
contains the Active table (`| Standard | Skill | Loads on |`, where "Loads on" = `applies_to`
globs or "any code edit") and the by-phase table (`| Phase | Invoke first | Loads |`), which is
the only statement of the phase chain. The table's rows come from the workspace's `work_type` (`workspace_prompts.ts::WORK_TYPE_PHASES`,
read through `planFor`): a `refactor` has no research row, a `spike` has only research, and
`bugfix`/`incident` skip review. A known work type also gets a **Work type** line naming its
path (spike / bounded / architectural) and phase sequence, and a **Gate** line naming the note
that must exist before the first source edit (§6). An empty or unknown work type renders all
five rows and no gate. The rest of the file is Current Task, Layout, the
two-column Routing table (a repo's own `CLAUDE.md` when it exists; `.werkmeister/werkmeister-context.md`
for everything about the running feature — URL, `X-Feature` cookie, ports, lifecycle, health
checks; `contract` notes for multi-repo workspaces), the Context Budget rule (≤3 files/step), and
the Notes pointer. `.werkmeister/werkmeister-context.md` is written by the compose generator and is
scoped to the workspace: through-Caddy health checks only for its local services' hosts, the
feature URL and browser cookie, and a Services table carrying each service's path in its repo.

The `CLAUDE.md` is a **compiled projection — never hand-edited**, and it holds no durable
state: it *points* at `.werkmeister/notes/` rather than containing handoff content, so
regeneration can never clobber working state.

### 5.4 Generated agents — `.claude/agents/` (`packages/werkmeister-core/src/agent_gen.ts`)

Principle: **phase gates tools, archetype gates context.** They are orthogonal — composed,
never cross-producted, so a 2-archetype workspace generates ~5–7 agent definitions, not 30.

- `w9r-researcher`: `tools: Read, Grep, Glob, Write` (Write solely for the finding note).
  Return contract: write `.werkmeister/notes/NNN-finding-<slug>.md`, return a 2–3 sentence summary
  + note path + open questions.
  Its body carries the investigation method (present options, tag claims
  verified/inferred/assumed, hold givens, bound the investigation, validate against named
  standards, deliverable shape): the method loads in the subagent that investigates, not in
  the main agent that dispatches.
- `w9r-tester-<archetype>` (one per archetype present): `tools: Read, Grep, Glob, Bash, Edit`;
  Edit restricted to test files by role. The definition embeds only that archetype's services,
  their resolved test commands, and pointers to its standards.
  For each service with a `feature_router:` host it also carries a guarded proxy smoke
  check — a `docker ps` guard, then `curl` through Caddy with the `X-Feature` cookie —
  reported SKIPPED when the container is not running; the tester never starts containers.
  Stale tester agents are pruned on re-init.

Every agent is **role-framed *and* tool-gated**: framing does the everyday work, the `tools:`
line makes misbehavior impossible (harness-3).

**Orchestration is human-in-the-loop.** Subagents cannot converse with the user — no
AskUserQuestion, no mid-run checkpoint. So the main agent is the dispatcher, phases are
user-invoked (no autonomous chaining), every return contract includes open questions that the
main agent surfaces before dispatching the next phase, and **implement stays in the main
agent** where the user watches and corrects live.

### 5.5 MCP projection — `.mcp.json` (`packages/werkmeister-core/src/mcp_gen.ts`)

The union of present archetypes' `mcp_servers` is written to a project-scope `.mcp.json` at
the workspace root — the surface every launch path respects. `mcp_servers` unions across
archetypes (connection is cheap; schemas defer until ToolSearch); `agent_tools` is **never**
unioned — one narrow specialist per archetype.

Server *definitions* live in the top-level `mcp_servers:` registry in services.yaml (verbatim
`.mcp.json` bodies; secrets stay out via `${VAR:-}` session-start env expansion). The
generator's managed namespace is the registry's names — added, refreshed, pruned. User-added
servers under other names are preserved; unparseable files are left untouched.

### 5.6 Generated hooks — `.claude/settings.json` (`packages/werkmeister-core/src/harness/claude/hooks_gen.ts`)

Two managed hooks, merged marker-based into the user's settings (stale managed entries are
replaced, everything else preserved, malformed user JSON left untouched):

- **SessionStart**, matcher-less: `werkmeister notes context`. Fires on every new context window —
  startup, resume, clear, and **post-compaction** (`source: compact`). See §5.8.
- **PreToolUse**, matcher `Edit|Write`: the standards gate. See §6.

There is deliberately **no PreCompact hook**: its stdout cannot reach the model (it can run
commands or block compaction, but has no `additionalContext`), so it cannot ask the model to
checkpoint before the squash. SessionStart's `compact` source covers the same boundary from
the other side.

Trust gotcha: project-scope `.claude/settings.json` hooks only fire after the user trusts the
workspace folder. Acceptable, since the user creates these workspaces. Headless `-p` runs load
hooks unless `--bare`.

### 5.7 Notes — `.werkmeister/notes/` (filesystem, harness-independent)

Feature-lifetime working state, not documentation: notes live and die with the workspace. One
note per file, `NNN-<type>-<slug>.md`, ordered by creation. Conventions in
[notes-conventions.md](notes-conventions.md); plumbing in `packages/werkmeister-core/src/notes.ts`.

```yaml
---
type: finding | decision | attempt | handoff | contract
phase: research | implement | test | review
author: main | <subagent name>
refs: [src/paginate.ts, frontend]
status: open | decided | superseded | graduated
---
```

`decided` marks a `decision` note as user-approved. `openDecisions()` keeps decided notes, so
`werkmeister notes context` re-injects the approved spec every session.

- **finding** — research output: root cause, evidence with `file:line` refs, proposed fix.
- **decision** — settled choices + why. Workspace-scoped "don't re-litigate." Binding.
- **attempt** — tried-and-failed approaches; the most valuable and most-lost context.
- **handoff** — phase/session transition state: done / in-flight / next / open questions.
- **contract** — cross-repo interface changes.

Rules: **supersede, never delete.** Writes are contracted (entry skills instruct capture *at
the moment*, agents have return contracts); reads are phase-entry. No compiled index — agents
list the directory, which is always fresh and needs zero machinery.

A workspace's `starting_prompt` **is** a handoff — from the workspace creator to the first
session — so `init-workspace` seeds it as the first `handoff` note. It then flows through every
existing mechanism with no special casing, and the first real `w9r-handoff` supersedes it
naturally. Seeding happens only when a prompt exists; a placeholder handoff written by an
older CLI (author `workspace-creation`, no prompt) is superseded by the next init that has
one. Any other handoff note blocks re-seeding — including its own prior seed: once a prompt
has been seeded, a later edit to `starting_prompt` does not update the note.

`werkmeister feature down` prints the latest `handoff` and all open `decision` notes to the terminal
before removing the workspace, and offers graduation of decision notes into the standards
tree. No automatic writes to PR bodies or tickets — the human decides what graduates.

### 5.8 Session re-injection — `werkmeister notes context`

`apps/cli/src/commands/notes.ts`, run by the SessionStart hook. Ordered output:

1. **Active-standards block first**: skill name + summary for every standard whose `applies_to`
   matches the branch diff, wording conditioned on the hook `source` (compaction vs fresh),
   plus the compressed **precedence directive** — harness-7: summaries re-anchor awareness,
   precedence restores compliance.
2. Notes preamble + latest handoff + open decision notes (each body capped at 3,500 chars).

On `source: compact` or `clear` it also **resets the gate's session state** (§6) — the context
was wiped, so delivery must happen again.

Never raises; silently empty outside a workspace. Total output is bounded by the harness-side
10k hook-output cap.

## 6. Enforcement — the PreToolUse standards gate

`packages/werkmeister-core/src/gate.ts` (built entry: `apps/cli/src/lib/gate.ts`). Everything in §5 is *voluntary*: nothing structurally guarantees
`w9r-implement` ran before the first edit. The gate closes that hole.

**Deny-once-with-payload.** On each `Edit`/`Write` it denies the first governed edit per
session × domain, carrying the loading instructions in the deny reason, then allows everything
after. The denial is not an error — the model follows the instructions and retries.

Decision table (`decide`):

1. Resolve the workspace root; load the manifest `.werkmeister/standards.json`; load session state
   `.werkmeister/.gate/<sessionId>.json`.
2. **Phase gate.** If the manifest carries `phase_gate` (compiled at init from the work type,
   `workspace_prompts.ts::WORK_TYPE_PHASES`) and the edited path is inside the workspace and
   not under `.werkmeister/`: scan `.werkmeister/notes/NNN-<note>-*.md`. A note satisfies the gate when
   its `status` is not `superseded`/`graduated` and, if the gate names a status (`decided` for
   `feature`), equals it. No satisfying note → deny with the phase-gate text.
3. Find the first not-yet-delivered domain whose `applies_to` globs fnmatch the edited path.
4. If phase entry was already delivered and no domain matched → allow.
5. Otherwise emit a **coalesced** deny: the phase-entry instruction (if undelivered) + the
   domain-skill instruction with the standard's summary (if matched) + the precedence text —
   one deny, never two.
6. Record delivery and allow the retry.

**Fail-open throughout.** Every failure mode — no workspace, no manifest, corrupt or
unwritable state, malformed input — resolves to *allow*. A broken gate must never tax every
edit, and an unwritable state dir must never become a deny-every-edit loop. The hook always
exits 0.

**Two deliberate departures for the phase gate.** It is *deny-until*, not deny-once: it is an
approval gate, and a once-only deny would mean "acknowledge you skipped approval, then
proceed". The note is the only key. And it keeps *no state* in `.werkmeister/.gate/`. A missing
notes directory counts as "no notes" and denies; every other read failure, and a note with no
frontmatter block, fails open. Status is read with a regex, not YAML, to keep the module
builtins-only.

**The manifest is a compilation, not a second source of truth.**
`buildStandardsManifest`/`writeStandardsManifest` emit `.werkmeister/standards.json` (`domain →
{applies_to, summary}` for every active non-universal standard, the active universal keys, and
`phase_gate` when the work type has one) from the same `resolveActiveStandards` output that
produces the CLAUDE.md routing table. It cannot diverge from the table. The one exception is
`phase_gate`: only `werkmeister workspace init` introduces it, alongside the CLAUDE.md that explains
it. `werkmeister skills sync` recompiles `phase_gate` from `.werkmeister/workspace.yml`'s `work_type`
only when the on-disk manifest already carries one — so a gate survives sync, and a work type
without a gate (`refactor`) drops it — and never adds one to a workspace whose manifest has
none; `werkmeister skills check` does not call such a workspace stale.

**Latency.** The gate fires on every `Edit`/`Write`, so the module is deliberately
dependency-light — node builtins only, no commander/yaml/nunjucks, nothing touching the
config/YAML chain. The hook runs `node dist/lib/gate.js` directly, bypassing the argparse-heavy
main entrypoint (measured at 250–460ms cold, well past the <200ms budget). `werkmeister internal gate`
imports the same module for manual runs and tests — one implementation either way.

One deliberate duplication: the precedence sentence is copied from `notes.ts` rather than
imported, to keep the import graph light. It carries a `ponytail:` comment saying so.

## 7. Validation gates

- **`werkmeister standards check`** — structural regression gate over the standards *source* tree.
  `validateStandardModules` (frontmatter integrity, summary/applies_to/phase shape,
  domain-matches-location) + `validateModuleReferences` (dead pointers, lingering
  `TODO(graduate)` markers, placeholder `canonical: TODO`, unlinked references) +
  `validateServiceStandards` (services.yaml ↔ standards drift). Scans files directly, upstream
  of the forgiving loader, so silent-drop breakage is caught. Exits 1 on any malformed
  standard.
- **`werkmeister skills check` / `sync`** — per-workspace projection freshness: missing, stale, or
  orphaned `w9r-*` skills. Also run from the SessionStart hook, so a workspace repairs its own
  projection before the session reads it.

**Automated test coverage is thin.** `apps/cli/src/lib/__tests__/gate.test.ts` (22 tests) and
`packages/werkmeister-core/gate.test.mjs` (phase gate) cover the gate;
`packages/werkmeister-core/agent-gen.test.mjs`, `harness-claude-md.test.mjs`, and
`workspace-skills-scope.test.mjs` cover agent generation, CLAUDE.md generation, and skill
scoping; `apps/cli/src/lib/__tests__/universal_standards.test.ts` covers standards resolution
and the manifest, `hooks_gen.test.ts` the hooks, `packages/werkmeister-core/notes-context.test.mjs`
notes re-injection, and `mcp-gen-vars.test.mjs` MCP variable handling. Everything else is
exercised only by running `werkmeister workspace init` and the two check commands above. Treat
`standards check` and `skills check` as the regression gates, and run them after any change to
the standards tree or the generators.

## 8. Context cost profile

- Standing cost: ~3–7 tokens per projected skill (headless-measured; TUI unverified).
- `w9r-implement` entry: ~3.1k tokens (entry skill + comments + engineering).
- `w9r-research` entry: ~0.7k tokens (thin dispatcher; the method lives in the subagent).
- Incremental per domain touched: ui ~340, service ~1,270, config ~330, auth ~440, testing
  ~240, observability ~260 tokens; references ~230–390 each, on suspicion only.
- `w9r-review` entry: ~2.6k + diff-matched domains.
- Research/test phases: ~0 main-context tokens (subagent isolation; summary + note pointer
  back).
- Re-injection block: tens of tokens (pointers + summaries + precedence line, not bodies).

## 9. Evidence base

All n=3-scale — directions, not effect sizes. Harnesses 1–4 on Sonnet, 5–7 on Opus/Haiku 4.5.
The harnesses and raw results are not published.

| # | Question | Result |
|---|----------|--------|
| 1 | Standing token cost of skills | ~3–7 tok/skill; bodies fully lazy; description length free |
| 2 | Trigger timing | description-gating collapses (0/16 ui/api); phase-entry chain 15/15 preventive |
| 3 | Subagent tool-gating | instruction/role/gate all 0-edit at N=3; gate = "cannot misbehave" guarantee |
| 4 | Notes persistence | contracted writes 3/3, uncontracted 0/3; read-but-not-applied failure mode identified |
| 5 | Read-but-not-applied fix | precedence block load-bearing (Haiku 0/3→3/3); recitation zero measured keep (kept as insurance) |
| 6 | Loaded→applied baseline | 9/9 applied vs 0/9 control across 3 standards (Haiku) |
| 7 | Post-compaction re-inject | summary-only re-anchor fails under conflicting task nudge (0/3 even enriched); precedence directive is the required ingredient |
| 9 | Gate deny-payload efficacy | ungated floor 0/3; the deny payload (summary + precedence, **no standard body**) reached 7/9 vs harness-6's 9/9 loaded ceiling, and 8/9 with the full body added — a real lift on every bait, short of the ceiling on the one bait whose numeric idiom the summary never names |

Known-unmeasured: whether agents invoke `w9r-implement` unprompted in production sessions;
implement-phase in a subagent; interactive-TUI standing costs; hook coverage across clients;
recitation in the >135K-burial regime; main-agent mid-session capture compliance; gate
deny-retry compliance at scale.

## 10. Known limitations

1. **Invariant tier is prose-defined** — no machine check of diff compliance against
   must-never rules.
2. **The gate is fail-open by design** — it raises the floor but cannot guarantee delivery;
   any error path allows the edit.
3. **The gate fires after drafting.** It can only trigger a revision pass, never prevent the
   first draft. `task_signatures` (§4.3) covers the pre-authoring window; phase entry remains
   the preventive path.
4. **Projection staleness is repaired one session late.** The SessionStart hook syncs a
   drifted workspace, but a workspace nobody opens stays stale, and the repair lands as the
   window opens rather than the moment the standards tree moves.
5. **fnmatch root-level under-match** (§4.2) — accepted, documented inline.
6. **10k hook-output cap** bounds how much note context re-injection can carry.
7. **Deferred:** review agents and a plan agent (the built-in Plan agent may suffice).

## 11. Portability

The system's logic — content model, resolution, generation, notes, validation — is plain
TypeScript + markdown and ports as-is. The **delivery layer** is the only harness coupling. To
re-implement on a different coding agent, the target must offer:

| Requirement | Used by | Claude Code mechanism | Acceptable substitute |
|---|---|---|---|
| R1. On-demand instruction packages with a standing one-line index and lazy bodies | domain skills, entry skills | `.claude/skills/` | any lazy-loadable instruction file the agent is told to read; worst case a `Read` tool + strong file identifiers |
| R2. Always-on project instruction file for the routing table | CLAUDE.md routing block | `CLAUDE.md` | `AGENTS.md` or equivalent |
| R3. Session-start injection hook (fires on new windows *and* post-compaction), stdout→context, with a known output cap | notes + standards re-injection | SessionStart hook (`source` distinguishes compaction) | any session-lifecycle hook that can run a CLI and inject text; if absent, fold re-injection into R2 and accept weaker post-compaction behavior |
| R4. Subagent definitions with tool allowlists | w9r-researcher, w9r-tester-* | `.claude/agents/` frontmatter `tools:` | any agent-spawn primitive with tool restriction; if only role-prompting exists, accept "reliably behaves" instead of "cannot misbehave" |
| R5. Pre-edit tool hook that can deny with a message the model reads | the standards gate | PreToolUse `Edit\|Write` with deny reason | any pre-tool interception returning text to the model; if absent, the enforcement floor is lost and delivery is voluntary again |
| R6. Plain filesystem access in the workspace | notes, handoffs, generation targets | — | universal |
| R7. (Optional, upgrade) Path-glob-conditional rule injection evaluated per model call | replaces the voluntary domain-loading chain | `.claude/rules/` `paths:` frontmatter | Cursor rules globs; OpenCode via the `opencode-rules` plugin |

**Port checklist:** (1) point the generators' output paths at the target's skill/agent/rules
locations; (2) re-express the SessionStart and PreToolUse hooks in the target's hook config;
(3) re-run harness-6-style loaded/control cells and a harness-7-style post-compaction cell on
the target — behavioral results are harness-specific and must be re-earned, not assumed. If
the target supports R7, deliver each rule with the precedence directive embedded (harness-7:
content without precedence does not produce compliance).

`packages/werkmeister-core/src/strategies/icm.ts` is a worked example of R2/R3 with no hooks at all: the `icm` strategy delivers the same standards through a staged-folder pipeline the agent walks by itself.

## 12. Conventions when extending

- **Phases are tool-gates, not workflow stages.** A phase (`w9r-research` / `w9r-implement` /
  `w9r-test`) exists to bind a **toolset + isolation profile**. Add a phase only when it changes
  the gate; never add one that shares a gate with an existing phase. Workflow stages map onto
  the existing gates rather than becoming new ones:

  | Workflow stage | Rides tool-gate | Why |
  |---|---|---|
  | research / design / plan | `w9r-research` (read-only + doc/notes write) | all three are read-only exploration writing a *doc, never source* — one profile |
  | implement | `w9r-implement` (full edit tools, **main agent**) | live human correction is the point |
  | test | `w9r-test` (run/edit-tests, per-archetype subagent) | — |

  So **do not add `w9r-design` / `w9r-plan` phases** — they gate nothing new. Design and plan are
  represented by their *artifacts*, which already flow through existing machinery: decisions →
  `decision` notes (binding, read by `w9r-implement`), specs and plans → ordinary docs.
- **New standards rules graduate through the pipeline** (`decision` note → `werkmeister notes
  graduate` → `w9r-author`). Repo docs are the deep-reference tier those rules link to, never a
  second rules channel.
- **Point, never copy.** The system's own rule applies to its own docs: this file states
  current state; nothing duplicates a standard body, a rule, or a resolution algorithm that
  lives in code.

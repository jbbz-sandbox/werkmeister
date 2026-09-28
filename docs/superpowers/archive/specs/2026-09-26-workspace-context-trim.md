# Workspace context trim — spec

**Status:** proposed
**Scope:** `packages/sandbox-core` generators, `apps/cli/infra/skills` entry skills,
`docs/jit-context-system.md`, `docs/notes-conventions.md`.

## 1. Problem

An audit of a freshly generated workspace (`~/features/test`, single repo, one
`node-web` service) against the rules in `docs/jit-context-system.md` found seven
places where the generated context either breaks the system's own principles or
costs standing tokens for no return:

| # | Finding | Rule it breaks |
|---|---------|----------------|
| 1 | Feature-testing instructions (URL, `X-Feature` cookie, `/__sandbox`) sit in the always-on `CLAUDE.md`, duplicated in `.sandbox/sandbox-context.md` and the plugin's `sandbox-feature-test` skill. No phase owns "verify the running feature through the proxy", though starting prompts ask for it. | Map, not territory (§2); phase gates tools, archetype gates context (§5.4) |
| 2 | The seeded `handoff` note says "no starting prompt was provided" while `workspace.yml` carries a full prompt. The first init ran with only `work_type`, seeded a placeholder, and the write-once rule then blocked the real prompt forever. The SessionStart hook re-injects the empty note every session. | Persistence must be contracted (§2); starting prompt is a handoff (§5.7) |
| 3 | All nine `sb-*-standard` skills are projected even when the routing table marks four "Not active — do not load". | Subagent tool gates convert "reliably behaves" into "cannot misbehave" (§2) — the same logic applies to projection |
| 4 | `sb-research` is 7 KB, the largest projected file. ~5 KB is investigation method that loads into the **main** agent, while the `sb-researcher` subagent that does the investigating gets none of it. §8 claims research costs ~0 main-context tokens. | Phase gates tools, archetype gates context (§5.4) |
| 5 | `CLAUDE.md` states the phase chain twice (paragraph + table) and carries operator advice ("sessions must start at the workspace root") the model cannot act on. | Token conservation (§1) |
| 6 | `sandbox-context.md` lists health-check curls for every Caddy host on the machine (4 hosts, 1 relevant), a hardcoded Infrastructure table whose MongoDB port collides with the workspace's own `backend` forward port, and `service-map.md` duplicates its Services table with nothing routing to it in a single-repo workspace. | Domain and service awareness (§1) |
| 7 | `sb-implement` spends 1.8 KB justifying a two-line rule and repeats the ponytail marketplace install command every implement phase; both generated agents end with "read CLAUDE.md first", which Claude Code already injects into subagents. | Token conservation (§1) |

## 2. Goals

1. Every generated artifact carries content only for the sessions and phases it
   applies to. Nothing in `CLAUDE.md` is repeated in a skill, agent, or
   `.sandbox/` file.
2. The starting prompt reaches the first session, and a later edit to it reaches
   the next one.
3. The proxy smoke check has an owner: the tester agent, which already has Bash.
4. `docs/jit-context-system.md` remains the single current-state document and is
   updated in the same change.

Non-goals: new phases (§12 forbids them), changes to the standards tree, changes to
the `sandbox-tools` plugin, the workspace-root repo's own `README.md` (lives in the
`sandbox-workspace` repo, not here).

## 3. Design

### 3.1 Feature testing moves to the tester agent and `sandbox-context.md`

**Remove** `buildFeatureTestingSection` from `claude_md.ts` and its call in
`buildClaudeMd`. The Jira link it carried already appears in "Current Task".

**Routing table** (`buildRoutingTable`): the two `sandbox-context.md` rows collapse
into one and the "Also read" column goes away (it only ever pointed at the
service map, which §3.5 removes):

```
| Task | Read |
|------|------|
| Working in <repo> | <repo>/CLAUDE.md |
| Running the feature — URL, X-Feature cookie, ports, lifecycle, health checks | .sandbox/sandbox-context.md |
| Cross-repo contract change | .sandbox/notes/ (`contract` notes) |
```

**`sandbox-context.md` "Proxy Routing"** gains the feature URL and the browser cookie
line that `CLAUDE.md` used to carry, so the content moves rather than vanishes:

```
**Feature URL:** https://<host>/<test_path>

Set the routing cookie in the browser (DevTools console):
    document.cookie = "X-Feature=<feature>; domain=.<local_domain>; path=/; SameSite=Lax";
or visit https://<host>/__sandbox and select `<feature>`.
```

`<host>` is `resolveProxyHost(localServices)` (already in `claude_md.ts`; becomes an
export so `agent_gen.ts` can use it). `buildSandboxContextMd` takes a new optional
`testPath` argument; `generateWorkspaceCompose` takes it as a new optional fourth
argument and `provisionWorkspace` passes `meta["TEST_PATH"]`.

**Tester agent** (`buildTesterAgent`): each service in the spec may carry `url`
(the routed host, plus `testPath`). When any service has one, the agent body gains
this block between TEST COMMANDS and the edit rule:

```
PROXY SMOKE CHECK — after the unit tests, only if the container is running
(`docker ps --format '{{.Names}}' | grep -qx <feature>-<service>`); otherwise
report it SKIPPED (containers not up) — never start them yourself:
- <service>: curl -sk -b "X-Feature=<feature>" -o /dev/null -w "HTTP %{http_code}\n" "<url>"
Report the HTTP code per service. Anything other than 2xx/3xx is a failing
result with the code as the assertion.
```

`buildTesterSpecs` gains `feature: string`, `routers: Record<string, FeatureRouter>`
and `testPath: string` parameters. `provisionWorkspace` builds `routers` with
`loadFeatureRouters(servicesConfig)` inside a try/catch that falls back to `{}`
(no ingress config → no smoke block, never a failed init).

**`sb-test` skill**: names the two paths in one bullet — the tester agents run the
proxy smoke check; for a headed browser session use the plugin's
`sandbox-tools:sandbox-feature-test` skill. Its two `service-map.md` references
become `.sandbox/sandbox-context.md` (Services table).

### 3.2 Starting-prompt seeding

`seedStartingHandoff(workspaceRoot, startingPrompt, workType)`:

- Returns without writing when `startingPrompt` is empty. No placeholder is ever
  written; the work-type line it used to carry is already in the by-phase table.
- A `handoff` note is a **placeholder** when `frontmatter.author ===
  "workspace-creation"` and its body does not contain the prompt marker
  ``Seeded from `starting_prompt` ``. If the only handoff notes present are
  placeholders, each is marked `status: superseded` in place and seeding proceeds.
- Any other existing handoff (real or a previous seed) still blocks, as today.

Exported for tests. `docs/notes-conventions.md` rule 1 and `jit-context-system.md`
§5.7 are reworded to match ("seeded only when a prompt exists; a placeholder seeded
by an older CLI is superseded on the next init").

### 3.3 Projection scoped to active standards

`renderWorkspaceSkills(standardsDir?, entrySkillsDir?, active?: string[] | null)`:
when `active` is an array, standards bundles are kept only for
`skillNameFor(domain)` with `domain ∈ active`. `null`/`undefined` means no filter
(today's behaviour, and the fallback when the active set cannot be resolved).
Entry skills are never filtered.

`writeWorkspaceSkills` and `checkWorkspaceSkills` take the same optional `active`.
A new `resolveWorkspaceActive(workspace): string[] | null` in `workspace_skills.ts`
holds the resolution that `resolveWorkspaceManifest` does today;
`resolveWorkspaceManifest` calls it. `syncSkills` and `checkSkills` pass its result;
`provisionWorkspace` passes the `active` it already computed in step 5b (or `null`
when there are no modules).

With inactive skills absent, `buildStandardsRoutingSection` drops the
"Not active (…) — do not load" line. The `notActive` parameter goes away.

### 3.4 Thin `sb-research`, method in `sb-researcher`

`apps/cli/infra/skills/sb-research/SKILL.md` keeps: Step 0 (notes), the no-standards
rule, **Establish scope first** (the main agent asks the user via AskUserQuestion —
the subagent cannot), spawn the agent **passing scope, givens, and deliverable shape
in the prompt**, relay + open questions, the delegate-vs-read-inline rule (main-agent
guidance), and Exit. Target ≤ 2.5 KB.

`buildResearcherAgent` gains the method sections verbatim except where they assume a
user is present: **Present options, don't pick**, **Tag every non-trivial claim**,
**Anti-relitigation**, **Bound the investigation**, **Validate against the code
standards — named, not loaded**, **Deliverable shape**. "Ask (AskUserQuestion)"
becomes "record it under OPEN QUESTIONS".

### 3.5 Trims

- `buildStandardsRoutingSection`: delete the "Phase entry:" paragraph and the
  "Sessions must start at the workspace root" blockquote. The by-phase table's
  header becomes `| Phase | Invoke first | Loads |` and the implementing row spells
  out the universal base: ``universal base (`ponytail` + `sb-comments-standard` +
  `sb-engineering-standard`) + rows matching the files you edit`` (names derived
  from `universalStandards(modules)` as today).
- `buildSandboxContextMd`: health-check curls only for hosts of services in
  `localServices`; the hardcoded Infrastructure table is deleted (the Services
  table already lists every k8s-forwarded service with its port); the Services
  table gains a `Path in repo` column from `servicesConfig[svc].path`.
- `service-map.md`: `buildServiceMapMd` and its write step are deleted;
  `buildClaudeMd`/`buildRoutingTable` lose `hasServiceMap`. Init no longer deletes
  an existing file (older workspaces keep theirs until they re-init; harmless).
- `sb-implement`: the "Keep verbose checks out of the dead middle" section becomes
  the rule, the two commands, and one sentence on why the grep pattern is
  runner-specific. The marketplace install command is dropped ("if `ponytail` is
  not installed, say so once and continue" stays).
- Both agents drop the trailing "Workspace context: read CLAUDE.md first" line.

### 3.6 Documentation

`docs/jit-context-system.md`: §5 (projection scoped to active), §5.2 (sb-research
and sb-test rows), §5.3 (routing table shape, no Feature Testing, no Not-active
line), §5.4 (researcher carries the method; tester carries the smoke check), §5.7
(seeding rule), §8 (sb-research entry cost), and a new line under §5.3 for what
`sandbox-context.md` carries. `docs/notes-conventions.md` rule 1.

## 4. Acceptance

- [ ] `npm test` in `packages/sandbox-core` passes, including the new tests.
- [ ] Re-running `sandbox init-workspace` on `~/features/test` yields: no
      `## Feature Testing` in `CLAUDE.md`; a `002-handoff-starting-prompt.md`
      containing the prompt and `001` marked superseded; only
      `sb-{comments,engineering,config,testing,ui}-standard` plus the seven entry
      skills under `.claude/skills/`; the tester agent containing a curl against
      `https://frontend.local.sandbox.com/`; `sandbox-context.md` with one
      through-Caddy curl and no Infrastructure table; no `service-map.md` written.
- [ ] `sandbox skills check` reports current immediately after that init.
- [ ] `sandbox notes context` prints the real prompt as the latest handoff.
- [ ] `CLAUDE.md` for that workspace is under 2.5 KB (was 3.9 KB);
      `sb-research/SKILL.md` under 2.5 KB (was 7.1 KB).

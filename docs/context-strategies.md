# Context strategies: making JIT and ICM selectable

Status: option B implemented — spec docs/superpowers/specs/2026-09-27-context-strategy-interface.md at 66703fc. The rest of this page is the exploration that chose it.

## Using it

Set `context_strategy: jit | icm` in `.werkmeister/workspace.yml`, or pass `--context-strategy <id>` / `WERKMEISTER_CONTEXT_STRATEGY` to `werkmeister workspace new` / `werkmeister workspace init`. Every create writes the key: with no strategy given, a new workspace gets `context_strategy: icm`. A `workspace.yml` without the key (one made before the field existed) reads as `jit`. `jit` generates the w9r-* skills, generated agents, gate manifest and SessionStart/PreToolUse hooks described below; `icm` instead writes a staged-folder pipeline — `CLAUDE.md`, `CONTEXT.md`, `BRIEF.md`, `_shared/standards.md`, `_shared/issues-report.md` and `stages/NN_*/CONTEXT.md` — with no notes, no gate and one hook, the PR guard shared with jit. Both strategies write the issue-filing guide from `issues_report.ts` (type bug | feature | task → label and template; werkmeister issues → `jbbz-sandbox/werkmeister`, app issues → the configured tracker): icm at `_shared/issues-report.md`, routed from `CLAUDE.md`; jit at `.werkmeister/issues-report.md`, linked from `CLAUDE.md`'s `## Issues` section.

Both strategies share one PR lifecycle — rules file, PR files, pre-PR gate, PR guard hook, close-out: [workspace-lifecycle.md](workspace-lifecycle.md).

### `autonomous` (#175)

`autonomous: true` in `workspace.yml` (or `--autonomous`, `WERKMEISTER_AUTONOMOUS=1`, or the form's checkbox; off by default) lets a headless session started with `claude-send "start the run"` go from stage 01 to `werkmeister pr open` with no stop. The person's review moves to the PR; `werkmeister pr gate` still applies.

- **icm**: each stage contract ends in `## Self-check` instead of `## Human check` — review `output/` once against `BRIEF.md` and the live issue, flip `status: proposed → decided`, and record each decision under `## Recommendations for reviewer` in the PR body. The propose stage's self-check sets the PR file to `status: approved` and runs `werkmeister pr open`. `CLAUDE.md`'s one rule becomes `## Stop points`: the PR URL, a question only a person can answer, or a gate failure outside the issue's scope. `_shared/pr-rules.md` says the agent approves.
- **both strategies**: `.claude/settings.json` gains `autonomousRules` (`hooks_gen.ts`) in `permissions.allow` and `AUTONOMOUS_DENY` in `permissions.deny`, both recorded in `.werkmeister/claude-permissions.json`, so flipping back to `false` and rerunning `init-workspace` (or `werkmeister feature up`) removes them. Each CLI rule is written for every launcher name (`werkmeister` and `w9r`), since a prefix rule for one never matches a call through another; the lists below say `werkmeister`. The allow rules stop at the workspace: git, read-only `gh`, the CLI commands that act on this feature (its name, or none for the cwd's), its own containers, local build and test, read-only utilities, and the read-only MCP tools. The deny rules, which outrank any allow including a person's user-level one, cover shared infra, other workspaces, the linked CLI and outward-facing acts. These are prefix rules, a guardrail rather than a boundary: `node -e` or a flag after the package (`npm install x -g`) still gets past. The PR guard still denies `gh pr create`. jit's gates are unchanged. Both lists are generated from `hooks_gen.ts` by `pnpm run docs:gen`; `<feature>` and `<svc>` stand for the workspace's feature and each of its services.

Autonomous allow rules:

<!-- generated:autonomous-allow -->

`Bash(git:*)`, `Bash(gh pr view:*)`, `Bash(gh pr checks:*)`, `Bash(gh pr diff:*)`, `Bash(gh pr list:*)`, `Bash(gh issue view:*)`, `Bash(gh run view:*)`, `Bash(gh run list:*)`, `Bash(werkmeister up)`, `Bash(werkmeister restart)`, `Bash(werkmeister feature up)`, `Bash(werkmeister feature restart)`, `Bash(werkmeister feature up --service:*)`, `Bash(werkmeister status:*)`, `Bash(werkmeister feature status:*)`, `Bash(werkmeister infra status:*)`, `Bash(werkmeister pr:*)`, `Bash(werkmeister issue view:*)`, `Bash(werkmeister issue start:*)`, `Bash(werkmeister init-workspace:*)`, `Bash(werkmeister workspace init:*)`, `Bash(werkmeister skills:*)`, `Bash(werkmeister standards:*)`, `Bash(werkmeister notes context:*)`, `Bash(docker ps:*)`, `Bash(npm ci:*)`, `Bash(npm run:*)`, `Bash(npm test:*)`, `Bash(npx:*)`, `Bash(node:*)`, `Bash(python3:*)`, `Bash(pnpm install --frozen-lockfile:*)`, `Bash(pnpm run:*)`, `Bash(pnpm test:*)`, `Bash(pnpm exec:*)`, `Bash(pnpm turbo:*)`, `Bash(ls:*)`, `Bash(cat:*)`, `Bash(grep:*)`, `Bash(find:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(sed:*)`, `Bash(diff:*)`, `Bash(wc:*)`, `Bash(test:*)`, `Bash(mkdir:*)`, `Bash(claude plugin validate:*)`, `Bash(claude plugin test:*)`, `mcp__plugin_werkmeister_werkmeister__issue`, `mcp__plugin_werkmeister_werkmeister__issue-statuses`, `mcp__plugin_werkmeister_werkmeister__status`, `mcp__plugin_werkmeister_werkmeister__workspace-prs`, `mcp__plugin_werkmeister_werkmeister__kube-context`, `mcp__plugin_werkmeister_werkmeister__k8s-forwards-status`, `Bash(werkmeister up <feature>)`, `Bash(werkmeister restart <feature>)`, `Bash(werkmeister feature up <feature>)`, `Bash(werkmeister feature restart <feature>)`, `Bash(werkmeister feature up <feature> --service:*)`, `Bash(werkmeister logs <feature>:*)`, `Bash(werkmeister test <feature>:*)`, `Bash(werkmeister services <feature>:*)`, `Bash(werkmeister feature logs <feature>:*)`, `Bash(werkmeister feature test <feature>:*)`, `Bash(werkmeister feature services <feature>:*)`, `Bash(docker exec <feature>-<svc>:*)`, `Bash(docker logs <feature>-<svc>:*)`, `Bash(docker restart <feature>-<svc>)`

<!-- /generated -->

Autonomous deny rules:

<!-- generated:autonomous-deny -->

`Bash(werkmeister proxy-reload:*)`, `Bash(werkmeister down:*)`, `Bash(werkmeister remove:*)`, `Bash(werkmeister remove-workspace:*)`, `Bash(werkmeister clean:*)`, `Bash(werkmeister setup:*)`, `Bash(werkmeister registry:*)`, `Bash(werkmeister connect:*)`, `Bash(werkmeister intercept:*)`, `Bash(werkmeister notes graduate:*)`, `Bash(werkmeister up infra:*)`, `Bash(werkmeister restart infra:*)`, `Bash(werkmeister stop infra:*)`, `Bash(werkmeister infra proxy-reload:*)`, `Bash(werkmeister feature down:*)`, `Bash(werkmeister infra down:*)`, `Bash(werkmeister feature drop:*)`, `Bash(werkmeister machine clean:*)`, `Bash(werkmeister machine setup:*)`, `Bash(werkmeister infra connect:*)`, `Bash(werkmeister infra intercept:*)`, `Bash(werkmeister workspace new:*)`, `Bash(werkmeister ws new:*)`, `Bash(werkmeister infra up:*)`, `Bash(werkmeister infra restart:*)`, `Bash(werkmeister infra stop:*)`, `Bash(werkmeister daemon install:*)`, `Bash(werkmeister daemon uninstall:*)`, `Bash(werkmeister daemon restart:*)`, `Bash(docker stop:*)`, `Bash(docker kill:*)`, `Bash(docker rm:*)`, `Bash(docker rmi:*)`, `Bash(docker compose down:*)`, `Bash(docker system prune:*)`, `Bash(docker volume rm:*)`, `Bash(docker network rm:*)`, `Bash(npm publish:*)`, `Bash(npm link:*)`, `Bash(npm unlink:*)`, `Bash(npm install -g:*)`, `Bash(npm install --global:*)`, `Bash(npm i -g:*)`, `Bash(npm i --global:*)`, `Bash(npm uninstall -g:*)`, `Bash(npm uninstall --global:*)`, `Bash(pnpm publish:*)`, `Bash(pnpm link:*)`, `Bash(pnpm unlink:*)`, `Bash(pnpm install -g:*)`, `Bash(pnpm install --global:*)`, `Bash(pnpm i -g:*)`, `Bash(pnpm i --global:*)`, `Bash(pnpm uninstall -g:*)`, `Bash(pnpm uninstall --global:*)`, `Bash(pnpm add -g:*)`, `Bash(pnpm add --global:*)`, `Bash(pnpm remove -g:*)`, `Bash(pnpm remove --global:*)`, `Bash(gh pr merge:*)`, `mcp__plugin_werkmeister_werkmeister__kube-switch`, `mcp__plugin_werkmeister_werkmeister__up`, `mcp__plugin_werkmeister_werkmeister__stop`, `mcp__plugin_werkmeister_werkmeister__restart`, `mcp__plugin_werkmeister_werkmeister__down`, `mcp__plugin_werkmeister_werkmeister__create-workspace`, `mcp__plugin_werkmeister_werkmeister__create-workspace-form`, `mcp__plugin_werkmeister_werkmeister__pr-approve`, `mcp__plugin_werkmeister_werkmeister__ask-pr-review`, `mcp__plugin_werkmeister_werkmeister__claude-send`, `mcp__plugin_werkmeister_werkmeister__claude-resume`, `mcp__plugin_werkmeister_werkmeister__connect`, `mcp__plugin_werkmeister_werkmeister__proxy-reload`, `mcp__plugin_werkmeister_werkmeister__remove-service`, `mcp__plugin_werkmeister_werkmeister__intercept`

<!-- /generated -->

Switching an existing workspace's `context_strategy` and rerunning `init-workspace` writes the new layer but leaves the old one's files in place, with a warning naming them; pass `--prune-context` to delete them too. Only paths that are git-tracked and clean are deleted — untracked, ignored or modified paths are kept and reported instead, since git is the only way to get them back.

## What the generator does today

The "context layer" is four of `initWorkspace`'s steps plus one refresh in `up`, now behind the strategy interface (`strategies/index.ts`) — `strategies/jit.ts` for the steps below, `strategies/icm.ts` for the ICM renderer:

| Step | Writes | Code |
|---|---|---|
| 5b active standards | `.werkmeister/standards.json` | `strategies/jit.ts:130`, `standards.ts:531` |
| 6 notes + CLAUDE.md | `.werkmeister/notes/001-handoff-*`, `CLAUDE.md` | `strategies/jit.ts:164`, `claude_md.ts:247` |
| 6a skills | `.claude/skills/w9r-*` | `strategies/jit.ts:182`, `workspace_skills.ts:118` |
| 6b agents | `.claude/agents/w9r-researcher.md`, `w9r-tester-*` | `strategies/jit.ts:187`, `agent_gen.ts:177` |
| 6c hooks | `.claude/settings.json` | `strategies/jit.ts:197`, `hooks_gen.ts:107` |
| `up` refresh | `.claude/settings.json` again (jit); removes it (icm) | `lifecycle.ts:133` |

The same writers are reachable from `werkmeister skills sync`, the SessionStart self-heal, and the MCP tools (`apps/werkmeister-mcp/src/tools.ts:489`, `:518`). `buildContext` (`notes.ts:282`) and `down` (`teardownNotes`) rewrite note frontmatter regardless. Everything else `initWorkspace` produces (worktrees, `.env`, compose, slot, `werkmeister-context.md`, service map) is strategy-neutral and both experiments used it unchanged.

There is no selector today. `workspace.yml` has `work_type` (picks the seeded handoff's phase) and `standards_override`, nothing that names a strategy. The schema is `additionalProperties: true`, so a new key costs a row in `_INPUT_FIELDS` (`workspace_prompts.ts:107`) and a schema property.

## What ICM needs from the same inputs

The hand-built `icm-ws2` maps onto existing data with no new inputs:

| ICM file | Source |
|---|---|
| `CLAUDE.md` (router, <60 lines) | `feature`, `task`, repo list; static route table |
| `CONTEXT.md` (pipeline table) | a stage template keyed by `work_type` |
| `BRIEF.md` | `starting_prompt` verbatim |
| `_shared/issues-report.md` | `buildIssuesReportMd` (`issues_report.ts`) — shared with jit's `.werkmeister/issues-report.md` |
| `_shared/standards.md` | `resolveActiveStandards` → rows pointing at `<standards_dir>/<domain>/STANDARD.md` (pointers, not copies) |
| `stages/NN_*/CONTEXT.md` + `output/.gitkeep` | the same template; contracts reference `.werkmeister/werkmeister-context.md` for infra facts |
| nothing in `.claude/`, no `.werkmeister/notes/` | — |

With an issue, both strategies also show it. The stored copy is `.werkmeister/issue.md`:

| | Issue section | Brief / first instruction |
|---|---|---|
| ICM | root `CLAUDE.md`, plus a "Where things live" row for `.werkmeister/issue.md` | `BRIEF.md` = issue section, then `description`, then `starting_prompt`. The "No starting prompt was given" note appears only with no issue and no prompt |
| JIT | `CLAUDE.md` Current Task, replacing the bare link | the starting-prompt handoff note opens with the issue section; written even when `starting_prompt` is empty, if there is an issue |

The stage template for `feature` is the four-stage research → spec → implement → ship pipeline in `~/features/icm-ws2/stages/`. `bugfix` would be reproduce → fix → verify → ship; `spike` would be two stages. Contracts must tell the agent to use `docker restart <feature>-<service>` to reload a running container, and `werkmeister feature up` once first when it is not running (a never-started container has no `pnpm` until `up` bootstraps it, SW-135), unless the `up` hook refresh is gated (next section).

## Option A — a `context_strategy` field, branch in core

`context_strategy: jit | icm | none` in `workspace.yml` (default `icm`; a file without the key reads as `jit`, `--context-strategy` on `workspace`/`init-workspace`, one row in `_INPUT_FIELDS`, one schema property).

- `initWorkspace`: steps 5b–6c run for `jit`; a new `icm_gen.ts` (one module, ~200 lines: five template literals plus the standards table) runs for `icm`; `none` writes nothing but `werkmeister-context.md`.
- `lifecycle.ts:133`: `if (strategy === "jit") writeWorkspaceHooks(...)`.
- `skills check|sync`, `notes context`, `hooks gate`, MCP `skills`/`hooks`: read the field, print "not applicable for strategy icm" and exit 0. The gate already fails open when `standards.json` is missing, so it is safe even if a stale hook survives.
- `down`/`teardownNotes`: skip when there is no notes dir (already effectively true).

Cost: a field, five `if`s, one renderer. Reuses standards resolution, worktrees, compose and slot logic untouched. Risk: the guard is repeated at every writer, so a sixth writer added later will forget it — exactly how `up` came to reinstall hooks in the first place.

## Option B — a strategy interface

```ts
interface ContextStrategy {
  id: "jit" | "icm";
  init(ctx: InitContext): void;      // steps 5b–6c or the ICM renderer
  refresh(ctx: WorkspaceContext): void; // what `up` calls; jit → writeWorkspaceHooks, icm → no-op
  check?(ctx): Drift[];              // backs `skills check` / plugin drift
}
```

`packages/werkmeister-core/src/strategies/{jit,icm}.ts`, a registry keyed by the same `context_strategy` field. `initWorkspace` and `up` call the strategy; the JIT-specific CLI commands become thin wrappers over `strategy.check()`/`refresh()`. Same field as A, but one dispatch point instead of five guards, and a third strategy (or an ICM variant with a different stage template) is one file plus a registry line. Cost: moving ~150 lines of `workspace_init.ts` into `strategies/jit.ts` and re-pointing four tests (`hooks_gen.test.ts`, `lifecycle_up_hooks.test.ts`, skills/agents tests). No behavior change for existing workspaces.

## Option C — Claude Code plugins

The exploration confirms the static parts of JIT could ship in a plugin: the seven entry skills are copied verbatim from `apps/cli/infra/skills/`, and `generateSkills` renders **all** `w9r-<domain>-standard` modules from the machine-global standards dir, not a per-workspace subset. `w9r-researcher` is static too. What is genuinely per-workspace is `CLAUDE.md`, `.werkmeister/standards.json`, `w9r-tester-<archetype>`, `.mcp.json`, and the hook *placement*.

But a plugin is a delivery vehicle, not a selector:

- Plugin hooks fire in every project the user opens, not just Werkmeister workspaces. The commands fail open (`command -v werkmeister … || true`), so it is noise rather than breakage, but `docs/jit-context-system.md` §5 keeps w9r-* out of the plugin on purpose (session scoping, plugin-refresh lag) and that reasoning still holds.
- ICM has nothing to put in a plugin. It is per-workspace files; the only reusable piece is the scaffolder, which is what `icm_gen.ts` is. The user-level `icm-architect` skill already covers the hand-built case.
- A workspace would still need a field to say which plugin's conventions it follows, so C does not remove A/B, it sits beside them.

Worth doing later for JIT's static assets (smaller per-workspace footprint, one place to update skills), independent of strategy selection.

## Recommendation

A now, shaped so B is a rename later: put the ICM renderer and the JIT steps behind two functions with the same signature from day one, even if the dispatch is an `if`. Concretely:

1. Add `context_strategy` (default `jit`) to schema, `_INPUT_FIELDS`, and the two CLI commands.
2. Extract steps 5b–6c into `jitInit(ctx)`; add `icmInit(ctx)` with the `feature` stage template; `up` calls `refreshContextLayer(ws)` which switches on the field.
3. Make `skills`, `notes context`, `hooks gate`, and the two MCP tools no-op with a message for non-JIT.
4. Port the two run-2 lessons into the ICM template: a `decided` status is the approval (no re-confirmation), and the stage 03 contract uses `docker restart`, not `werkmeister feature up`.
5. Add the harness cell: `werkmeister workspace new x --context-strategy icm` produces no `.claude/`, and `werkmeister feature up` in it leaves `.claude/` absent.

Skip C until the JIT plugin question is worth its own decision; skip a third strategy until someone has one.

## Evidence the choice matters

Run 2 (same task, same model, same brief; one run each, directional only): JIT 108 API turns / 4.89M input tokens / 1 new devDep / 3 off-protocol human turns; ICM 86 / 3.66M / 0 deps / 2, of which both were gate confirmations. Both met all eight acceptance criteria. Neither dominates: JIT needs less human attention per run, ICM spends fewer tokens and leaves a reviewable state on disk. That is the case for a selector rather than a replacement.

# sandbox-core

## 0.10.0

### Minor Changes

- afd99d4: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- 63fdd7b: Shared-infra `docker compose` calls now pass `-p sandbox-infra`, so a caller whose env sets `COMPOSE_PROJECT_NAME` (every workspace container) no longer addresses the shared stack as its own project, which used to report k8s-forwards unhealthy and then fail restarting it. `sandbox up`/`down`/`stop`/`restart` run inside the target feature's own container now refuse with `INSIDE_OWN_CONTAINER` instead of killing themselves with exit 137 (#198).
- a671c9f: An aborted stats collection now cancels the container stats requests in flight instead of waiting out a host-wide snapshot, so it stops right away however many containers are running, and the `stats-collect` aborted-run test no longer times out on a loaded host (#182).

## 0.9.1

### Patch Changes

- 304bb5c: `sandbox close-out` and `sandbox remove-workspace` now remove the workspace's per-feature Docker volumes (`docker compose down --volumes`) when they delete it, instead of leaving `<feature>-node-modules` and `<feature>-tools` behind. Plain `sandbox down` still keeps them.

## 0.9.0

### Minor Changes

- 09c0746: `sandbox pr gate`: a repo's registry `repo:` block can list `no_service_paths` (e.g. `docs`, `.changeset`, `README.md`); changes under them touch no service, so a docs-only PR no longer needs `skip_tests` for every service. The sandbox repo declares `docs`, `.changeset`, `.gitignore` and `README.md`.

### Patch Changes

- 5d20904: An ICM workspace's tracked `_shared/standards.md` no longer holds machine paths: each row reads `<standards_dir>/<module>/STANDARD.md`, with a line saying `sandbox standards check` prints that root and `sandbox setup` grants Claude Code read access to it. Opening the record on a machine with a different home dir or `overrides.standards_dir` no longer makes `sandbox skills check` report the file as drifted. Existing workspaces get the portable form on their next `sandbox skills sync` (#163).
- 69a386d: `sandbox up` now regenerates `<workspace>/.sandbox/supergraph-config.yml` on every run, not only when the slot changes, so a stale copy is removed when the registry has no GraphQL subgraph (#120).

## 0.8.0

### Patch Changes

- 594efe1: `sandbox init-workspace` no longer adds the current template's stage dirs beside an older ICM layout. In a workspace whose `stages/` holds dirs the current template does not render (e.g. `03_verify`/`04_ship` from before the rename to `03_exercise`/`04_propose`), init now warns and leaves `CLAUDE.md`, `CONTEXT.md`, `_shared/` and `stages/` as they are, and `skills check`/`sync` leave them alone too. Services are still reconciled into `docker-compose.yml`, `.env` and `.sandbox/sandbox-context.md`. To regenerate the pipeline from the current template, move `stages/` aside and rerun (#149).
- 542eecf: `generateSupergraphConfig` no longer creates an empty `<workspace>/.sandbox/` when the registry has no GraphQL service and there is nothing to write (#119).

## 0.7.0

### Patch Changes

- 1f9039f: `sandbox pr open` no longer fails to move a GitHub issue to "In Development" when the repo has no such label. The GitHub tracker now runs `gh label create <status> --color 1D76DB --force` before adding a status label, so the label is created when missing and left as is (same color) when present (#156).

## 0.6.0

### Patch Changes

- 2d701e4: `SANDBOX_FEATURE` is no longer read as the `feature` input. Every workspace container exports it as its own feature name, so a workspace created or inited from inside one was prefilled with that name. Pass `--feature` or set `feature:` in `workspace.yml` instead. The `sandbox-install` setup service now runs `npm ci`, so `sandbox up` no longer rewrites `package-lock.json`, and the compose-logs smoke test targets its own workspace's stack (#148).

## 0.5.1

### Patch Changes

- 47a7667: `discoverRepos` and `repoDirs` now share one rule for which workspace dirs are repos: dot-prefixed dirs are skipped and symlinked dirs count. Before, an icm workspace with a dot-prefixed or symlinked repo dir reported drift in `sandbox skills check` that `sync` could never clear (#110).

## 0.5.0

## 0.4.0

### Minor Changes

- 6d2333e: `sandbox setup` asks for the issue tracker (`overrides.issue_tracker`: `jira` or `github`). With `github`, issues are per repo and the tracker spans every repo in the services registry under `github_org`: `sandbox workspace` asks for a GitHub issue (`repo#n`, `owner/repo#n` or an issue URL; `--github-issue`) instead of a Jira ID, `CLAUDE.md` links it, and the issues guide sends app-code issues to those repos' issues. With `jira`, the issues guide sends them to the workspace ticket's Jira project. Jira links now use `jira.base_url` instead of a hardcoded site.
- 4ff0cc7: The `sandbox workspace` terminal wizard now renders from the same RJSF form schema as the browser form and MCP UI, so every surface shows the same fields, choices and validation. Local-service choices are listed under the repo that owns them in both the wizard and the create form. Removed `--print-prompts` and `--print-form-schema` from `workspace` and `init-workspace`; the form schema is built in-process by `getFormSchema`.
- 9a89e99: Generated workspaces include an issue-filing guide — `_shared/issues-report.md` for icm, `.sandbox/issues-report.md` for jit — routed from `CLAUDE.md`. Every issue has a type (bug | feature | task) that sets its GitHub label (`bug`, `enhancement`, `task`) or Jira issue type (Bug, Story, Task) and its body template. Bugs this workspace's changes caused are fixed in place; bugs that were already there, and features or tasks outside the workspace's task, are filed on `jbbz-sandbox/sandbox` or where the app code's issues live.

### Patch Changes

- 6f38fc7: `init-workspace` no longer treats plain directories (ICM `_shared/`, `stages/`) as repo worktrees when the workspace root is itself a git repo. Before this, it refused with "Refusing to remove worktree(s) with uncommitted changes" or tried to remove them, and it gitignored them. A directory now counts as a repo only if it has its own `.git`. Rerun `sandbox init-workspace` to clean the stale `/_shared/` and `/stages/` lines out of the managed `.gitignore` section.

## 0.3.0

## 0.2.0

## 0.1.3

### Patch Changes

- bf6d509: `.sandbox/workspace.yml` gains a `context_strategy` field (`jit` or `icm`, defaulting to `jit`) that selects which context layer `init-workspace` generates and `up` refreshes. `sandbox workspace` and `sandbox init-workspace` gain a matching `--context-strategy` flag (env: `SANDBOX_CONTEXT_STRATEGY`).
- 893492a: `sandbox skills`, `sandbox notes context` and `sandbox hooks gate` now dispatch through the workspace's `context_strategy` instead of assuming jit. `skills check`'s success line reads `Context layer fresh (<id>).`, and the "lags" hint now fires whenever the strategy's `check()` reports anything (previously only on drift). The MCP `sandbox-skills` tool returns `{ drift: string[] }` for `check` and `{ wrote: string[] }` for `sync`; `sandbox-hooks` now refreshes the workspace's context layer (jit: re-merge hooks; icm: remove sandbox-managed hooks) and returns `{ strategy: string }` instead of a hook file path. `sandbox-workspace`/`sandbox-init-workspace` gain a matching `context_strategy` argument.

## 0.1.2

## 0.1.1

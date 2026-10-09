# @jbbz-sandbox/sandbox-cli

## 0.4.0

### Minor Changes

- 6d2333e: `sandbox setup` asks for the issue tracker (`overrides.issue_tracker`: `jira` or `github`). With `github`, issues are per repo and the tracker spans every repo in the services registry under `github_org`: `sandbox workspace` asks for a GitHub issue (`repo#n`, `owner/repo#n` or an issue URL; `--github-issue`) instead of a Jira ID, `CLAUDE.md` links it, and the issues guide sends app-code issues to those repos' issues. With `jira`, the issues guide sends them to the workspace ticket's Jira project. Jira links now use `jira.base_url` instead of a hardcoded site.
- 4ff0cc7: The `sandbox workspace` terminal wizard now renders from the same RJSF form schema as the browser form and MCP UI, so every surface shows the same fields, choices and validation. Local-service choices are listed under the repo that owns them in both the wizard and the create form. Removed `--print-prompts` and `--print-form-schema` from `workspace` and `init-workspace`; the form schema is built in-process by `getFormSchema`.

### Patch Changes

- f934fbd: `sandbox setup` run from a checkout now says why it can't install the VS Code extension (no bundled `.vsix`) and points at building it from `packages/vscode-plugin`. The README documents installing the CLI from a clone with `npm link -w apps/cli`.

## 0.3.0

### Minor Changes

- 62207ac: Everything `sandbox connect` generates now lives under `~/.sandbox/infra/` instead of inside the CLI package: the Caddyfile, `features.json`, the pinned kubeconfig, the k8s forwards table, and (new) a `compose/k8s-forwards.override.yml` carrying the `k8s-forwards` ports and aliases that used to be rewritten in place inside `shared-infra.yml`. A global `npm install -g` therefore works on a root-owned prefix, and an upgrade no longer deletes a file a running container is mounting. **After upgrading, run `sandbox connect` once**: `docker compose` recreates `sandbox-caddy` and `k8s-forwards` on the new mount paths. The `sandbox-tools` skills read the Caddyfile from the new location.
- 1030846: The headless MCP server (`apps/mcp`) is bundled into the CLI package as `dist/mcp.js`, so `sandbox mcp` and the MCP server `sandbox connect` starts on 3002 work from an `npm install -g` with no checkout. `sandbox dashboard` falls back to that bundle when the workspaces dashboard app is absent, which keeps the `sandbox-tools` plugin's MCP entry serving the `sandbox-*` verbs on a package install; the dashboard itself (Jira, PRs, MCP-App UI) stays checkout-only. `sandbox connect` no longer prints a dashboard URL it did not start. Sourcemaps are dropped from the tarball. The sandbox-diagnose and sandbox-caddy-reload skills no longer import `dist/lib/caddy.js`, which the bundle never emitted.
- d4edb2e: `sandbox detect` now generates a repo's `.sandbox/services.yaml` from its package manifests, Dockerfiles, docker-compose files, Helm charts, k8s manifests and kustomize overlays, and re-runs only add what is missing. `--assist` asks Claude about the fields the scan had to guess. The old changed-service report is gone; the `sandbox-detect` MCP tool now returns the proposed fragment and writes it with `write: true`.
- b2bb6cc: The Sandbox Workspaces VS Code extension ships in the CLI package as `dist/sandbox-workspaces.vsix`, and `sandbox setup` offers to install it (section 8, now "VS Code"). It is versioned with the CLI, so a re-run upgrades a stale install and `--check` reports one. Only the packaged `.vsix` is ever installed — a checkout has none, since `prepack` builds it, not `build`.

## 0.2.0

### Minor Changes

- a6dc774: `~/.sandbox/services.yaml` is now generated from each repo's `.sandbox/services.yaml` fragment. `sandbox setup` scans `paths.repos_root` after cloning, merges the fragments under the sandbox's archetype/MCP defaults and over a new per-machine `~/.sandbox/services.local.yaml` (which now holds `k8s_context` and any hand edits), and writes the registry. New `sandbox registry sync` / `sandbox registry --check` run that step alone. A pre-existing hand-written registry is backed up to `services.yaml.bak-<ts>` on the first run; move its entries into the owning repos' fragments. The demo and empty registry seeds are gone: with no fragments found, setup says so instead of writing a skeleton.

### Patch Changes

- 0523997: claudeck is gone from this repo for good: `sandbox connect` no longer tries to start it (it lives in its own repo and starts itself), the `claudeck` self-host service is dropped from the sandbox registry fragment, and the `claudeck:sync` script moved with the folders merge into claudeck's workspace plugin.

## 0.1.3

### Patch Changes

- bf6d509: `.sandbox/workspace.yml` gains a `context_strategy` field (`jit` or `icm`, defaulting to `jit`) that selects which context layer `init-workspace` generates and `up` refreshes. `sandbox workspace` and `sandbox init-workspace` gain a matching `--context-strategy` flag (env: `SANDBOX_CONTEXT_STRATEGY`).
- 4fd6d67: `sandbox code [feature]` opens a workspace in VS Code, using the same `openWorkspace` call as the dashboard's `open-workspace` tool. With no argument it reads `FEATURE` from a `.env` file.
- 893492a: `sandbox skills`, `sandbox notes context` and `sandbox hooks gate` now dispatch through the workspace's `context_strategy` instead of assuming jit. `skills check`'s success line reads `Context layer fresh (<id>).`, and the "lags" hint now fires whenever the strategy's `check()` reports anything (previously only on drift). The MCP `sandbox-skills` tool returns `{ drift: string[] }` for `check` and `{ wrote: string[] }` for `sync`; `sandbox-hooks` now refreshes the workspace's context layer (jit: re-merge hooks; icm: remove sandbox-managed hooks) and returns `{ strategy: string }` instead of a hook file path. `sandbox-workspace`/`sandbox-init-workspace` gain a matching `context_strategy` argument.

## 0.1.2

### Patch Changes

- 5afc450: Phase gate: in a `feature` workspace, the PreToolUse gate denies source edits until a `decision` note in `.sandbox/notes/` reads `status: decided`; in a `bugfix`/`incident` workspace, until a `finding` note exists. `init-workspace` compiles the gate into `.sandbox/standards.json` as `phase_gate`; `sandbox skills sync` keeps it up to date but never adds it to a workspace that doesn't have it yet. Edits under `.sandbox/` are never gated, and the gate fails open on anything it can't read.
- 8e18c7d: The workspace's `work_type` now selects its JIT phases. The generated `CLAUDE.md` shows a **Work type** line, a **Gate** line and only that type's By-phase rows (a `refactor` has no research row, a `spike` only research, `bugfix`/`incident` skip review), and the seeded handoff starts at the type's first phase. `sb-research` ends a `feature` in a `decision` note with `status: decided` that records the user's answers and the approved design, and ends a `bugfix`/`incident` in a `finding` naming the root cause. An empty or unknown work type renders as before.

## 0.1.1

### Patch Changes

- 64237bb: Route the last ten direct `console.*` writes in `sandbox-core` (`compose`, `browser`, `safari`) through the reporter, so a library import can no longer corrupt `sandbox mcp --stdio`'s JSON-RPC stream. CLI output is unchanged, byte for byte.
- 98d346f: The dashboard's workspace up/stop/restart/down now call `sandbox-core/lifecycle` in-process instead of spawning the CLI, using a new `collectingReporter()` to build the transcript they return. Adds guards for a workspace with no `FEATURE` and for `FEATURE=infra`, and reloads the proxy after `down` (which `lifecycle.down()` does not do).
- 01ea20a: The k8s port-forward container now retries the cluster check at startup and exits non-zero if it never succeeds, instead of sleeping forever. Sleeping disarmed the `restart: unless-stopped` policy, so losing the boot race against the cluster left every forward dead until someone restarted the container by hand.
- d79ec6d: `sandbox up` can now actually repair an unhealthy k8s-forwards container. It ran `docker compose up -d`, which is a no-op for an already-running container — so the repair reported success without doing anything, and `up` then waited out its timeout for tunnels that were never coming back.
- b7ba5e2: `sb-research` gains the delegation rule (delegate for a conclusion, read inline what a correctness claim rests on), and `sb-implement`'s test-log example no longer teaches a loose `grep -i 'fail|error'` — that pattern returns 158 matches on a passing run of this monorepo's own suite.
- a4352a5: Ship `infra/compose/scripts/sandbox-install-startup.sh` (docker/compose/kubectl into a feature tools volume) and let the dashboard bind `HOST`, so the sandbox repo's own apps and packages can run as sandbox services.
- 98c1749: Workspaces carry only the context their sessions use. `init-workspace` seeds the `starting_prompt` handoff even after an older placeholder (which it marks superseded), and projects only the workspace's active `sb-*-standard` skills. The generated `CLAUDE.md` drops the Feature Testing section and the service map, and `sandbox-context.md` is scoped to the workspace's own hosts with the feature URL. The tester agent runs a proxy smoke check, the researcher agent carries the investigation method, and `sb-research` is a thin dispatcher.

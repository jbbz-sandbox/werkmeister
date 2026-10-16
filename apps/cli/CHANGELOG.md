# @jbbz-sandbox/sandbox-cli

## 0.10.1

## 0.10.0

### Minor Changes

- afd99d4: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

## 0.9.1

## 0.9.0

### Minor Changes

- 09c0746: `sandbox pr gate`: a repo's registry `repo:` block can list `no_service_paths` (e.g. `docs`, `.changeset`, `README.md`); changes under them touch no service, so a docs-only PR no longer needs `skip_tests` for every service. The sandbox repo declares `docs`, `.changeset`, `.gitignore` and `README.md`.
- f273764: `sandbox pr adopt <pr-number|url> [repo]` closes out a workspace whose fix landed somewhere else. It writes the PR file from `gh pr view` and records its status, so a merged PR is promoted to `shipped` with its release tag. `sandbox pr adopt --no-pr "<reason>"` covers a fix that is already on base with no PR: it writes a `closed` PR file with the reason. Close-out doesn't delete an adopted PR's branch. A PR file whose frontmatter isn't valid YAML now reports the parser's error.

### Patch Changes

- 617cea7: An `autonomous` workspace's allow list now includes `claude plugin validate` and `claude plugin test`, so a headless run can check a plugin's pane tests itself. A blanket `claude plugin:*` rule is still not granted, since it would also allow installing and uninstalling plugins.
- 5169257: `sandbox workspace` without `--context-strategy` (and every other non-interactive create: MCP, dashboard) now writes `context_strategy: icm` to the new `workspace.yml` instead of leaving the key out, which read as `jit`. Existing workspaces without the key still read as `jit`.
- f51c9c6: A CLI linked from a checkout now warns on stderr when its `dist` bundle was built from a different commit than the checkout's `HEAD`. The warning names both SHAs and the rebuild command. Published installs and `sandbox hooks` skip the check.

## 0.8.0

### Minor Changes

- c608d77: New workspace input `autonomous` (`--autonomous`, `SANDBOX_AUTONOMOUS`, `autonomous: true` in `workspace.yml`, or a checkbox in the create form, the terminal wizard and the `/workspaces` pane; off by default). When it is on, an icm workspace runs from stage 01 to `sandbox pr open` with no human check. Each stage contract ends in a `## Self-check`, the agent sets its own PR file to `approved` and records its decisions under `## Recommendations for reviewer`, and `CLAUDE.md` lists only three stop points: the PR URL, a question only a person can answer, or a gate failure outside the issue's scope. For both strategies, `.claude/settings.json` gets the Bash allow rules a headless `claude-send` session needs (`git`, `sandbox`, `docker`, `gh`, `node`, `npm`, `npx`, `python3`, read-only utilities) and the sandbox-workspace MCP server. These rules are recorded in `.sandbox/claude-permissions.json`, so turning `autonomous` off removes them. The PR guard still blocks `gh pr create`, and `sandbox pr gate` still applies. (#175)
- c7429a5: New workspaces default to `context_strategy: icm`. The wizard, browser form and `sandbox workspace` / `init-workspace` without `--context-strategy` now pick `icm`; pass `--context-strategy jit` for the JIT layer. A `workspace.yml` that has no `context_strategy` key still reads as `jit`, so existing workspaces are unchanged.
- ada1429: Workspace PR rules (`pr-rules.md`, the ICM router and the `workspace-pr` / `sb-pr` skills) now turn on the desktop app's Auto-fix for each PR right after `sandbox pr open`, instead of offering it. Auto-merge stays off.

### Patch Changes

- 4f43c80: docs(users-guide): list all four GraphQL service types (`graphql-subgraph`, `graphql`, `subgraph`, `federation`) that turn on supergraph generation, matching the code and the architecture doc.

## 0.7.0

### Minor Changes

- 0d96202: Every workspace's `.claude/settings.json` now gets `permissions.allow` rules for its services' registry test commands (the `docker exec` line `sandbox-context.md` prints, plus the bare command) and read-only git (`git diff`, `git status`, `git ls-files`), for both context strategies, on init and every `sandbox up`. Sandbox records the rules it added in `.sandbox/claude-permissions.json` and only ever removes those; hand-added rules are kept. `sandbox setup` gains an optional step that grants Claude Code read access to the standards dir in the user-level `~/.claude/settings.json` (`permissions.additionalDirectories`), so no machine path lands in a workspace; it asks first, and `--yes` never grants. (#144)

### Patch Changes

- eb9a4ef: `sandbox pr gate` accepts `skip_tests: { <service>: <reason> }` for a service that has a test command but no running container for its repo, so a workspace that runs no containers for the PR's repo can pass the test check. `sandbox pr status` no longer marks a `ship: tag` repo's PR `shipped` on merge because `skip_release` is set; it waits for a release tag containing the merge commit. (#145)
- 8085290: `sandbox up` no longer accepts `-s/--services` or `--force`. It never read them: `sandbox up -s <service>` exited 0 with nothing started and no warning. Both are now rejected as unknown options. To run a service locally, add it to `.sandbox/workspace.yml`, run `sandbox init-workspace`, then `sandbox up` (#153).

## 0.6.0

### Minor Changes

- 386759a: Validation guidance for services without a URL. `services.yaml` gains a `validate:` field (a service's own value beats its archetype's; defaults ship for `node-tool` and `mcp-client`), and `sandbox-context.md` opens with a How to validate table per service, rendering routing, Caddy and cookie sections only when a URL-addressed service needs them. `sandbox test` looks for a Playwright config in the workspace root, then each repo worktree; with no suite it runs nothing and prints each service's test command and validation instead. Fragments accept `type: extension`.

### Patch Changes

- 8e6b035: `sandbox setup` now prunes `/etc/hosts` entries and certificate SANs for services no longer in the registry, and `sandbox setup --check` reports them as stale (before, it only caught missing hostnames). Ingress hosts entries now live in a managed `# BEGIN sandbox ingress` … `# END sandbox ingress` block. The first run moves existing `127.0.0.1` lines under the ingress domains into it, and leaves every other line alone. Fixes #105.

## 0.5.1

## 0.5.0

### Minor Changes

- b451dd0: One workspace-create pipeline: every entry point (`sandbox workspace`, `--browser-form`, the MCP `workspace` / `create-workspace` tools, the /workspaces pane) goes through `createWorkspace`, which fetches the issue (failing the create when it can't be read), stores it in `.sandbox/issue.md`, and renders the same `## Issue` section in ICM and JIT. New `sandbox init-workspace --refresh-issue` and `sandbox workspace --no-distill`; `sandbox connect` checks issue-tracker sign-in; a placeholder Jira `base_url` counts as unset.
- 7e49187: Workspace PR lifecycle (docs/workspace-lifecycle.md): per-repo PR files with an approve flip, `sandbox pr gate|open|status` (pre-PR gate runs the registry test commands, exercise evidence and the repo's release check), a PR-guard hook that blocks `gh pr create` and `/create-pr` inside a workspace, `sandbox close-out`, `remove-workspace --abandon`, a registry `repo:` block for ship detection, and lifecycle state on the workspaces pane. ICM's `ship` stage is now `propose`, and `verify.md` is now `exercise.md`.

### Patch Changes

- 6a617cd: `sandbox registry sync` no longer aborts with "defined by both" when a linked git worktree of a repo sits under `paths.repos_root`; worktrees are skipped and only main checkouts are read (jbbz-sandbox/sandbox#136).
- 9bcabb0: sandbox-feature-test: `setup_feature.py` resolves the workspace through `paths.workspaces_root` like `resolveWorkspace` does, so running it from a workspace root (itself a git repo) no longer scaffolds `playwright.config.ts` and the spec into the workspaces root (#107).
- aa93534: The create form's rules live in sandbox-core (`validateFormData`, `repoSelectionError`, `mergeFormData`), shared by the browser form and the /workspaces pane. The pane now refuses Create without a service or repo instead of failing later in provisioning.

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

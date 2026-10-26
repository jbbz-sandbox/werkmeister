# sandbox-core

## 0.38.1

## 0.38.0

## 0.37.1

### Patch Changes

- 3c9e892: SW-100: Caddy starts on a fresh clone, a git worktree or an npm install. The generated `features.json` was file-bound inside the read-only `proxy/ui` mount, so Docker needed a gitignored `apps/cli/infra/proxy/ui/features.json` to exist as the mountpoint, and only old checkouts with a stale copy had one. It now mounts at `/srv/features.json`, and the Caddyfile's `/__werkmeister/features.json` handle serves it from there. The next `connect` / `up infra` regenerates the Caddyfile and recreates Caddy on the new mount. A leftover `apps/cli/infra/proxy/ui/features.json` in an old checkout is no longer read and can be deleted.

## 0.37.0

### Minor Changes

- 59ae387: SW-95: the shared-infra stack no longer says "sandbox". The compose project is `w9r-infra`, the containers are `w9r-caddy` and `w9r-k8s-forwards`, and Caddy's volumes are `w9r-infra_caddy-data` / `w9r-infra_caddy-config`. The dashboard's Jaeger and RedisInsight links point at `*.w9r-infra.orb.local`. On a machine still running the old `sandbox-infra` stack, the next `connect` / `up infra` takes it down first (its containers hold the names and ports 80/443 the new one needs) and then starts the renamed stack, so the proxy restarts once. `down infra` takes the old stack down too. Its volumes are kept unless you pass `--volumes`. Leftover `sandbox-infra_*` volumes can go with `docker volume rm`. An opted-in RedisInsight starts with empty settings, because its volume moves to the new project. Caddy's data is safe to lose: certs are bind-mounted from `certs_dir`.

## 0.36.2

## 0.36.1

### Patch Changes

- b5bec68: SW-97: `werkmeister migrate` no longer tells the person to run an `infra` subcommand, which doesn't exist. The refusal while shared infra is running now names `werkmeister down infra`, and the success message names `werkmeister connect`. A new test fails the build if any backticked `werkmeister …` command in migrate's messages isn't a registered CLI command.

## 0.36.0

### Minor Changes

- eabd324: SW-93: the Docker-side names and default domains no longer say "sandbox". New containers carry `com.werkmeister.*` labels, compose projects and per-feature networks are `werkmeister-<feature>`, features join the `werkmeister-shared` network, the built-in build caches live in `werkmeister-<key>` volumes, and the sandbox repo's setup service is `werkmeister-install`. A workspace brought up before this keeps running under its old `sandbox-<feature>` project and `com.sandbox.local.*` labels: slots, `status`, `stop`, `restart`, `logs`, the VS Code tree and the idle reaper all still find it, and its next `up` takes the old project down (keeping its node_modules volumes) before starting the new one. `down` and `close-out` remove both. Caddy and k8s-forwards join both shared networks, and `cache prune` also reaches a leftover `sandbox-<key>` volume. A fragment still naming its setup `sandbox-install` gets the renamed startup script. The default `local_domain`/`remote_domain` are now `local.werkmeister.io`/`remote.werkmeister.io`; a machine whose `config.yaml` sets them (every `setup` run writes them) keeps its own. The X-Feature cookie, the `connect` tool links and the docs-site's allowed hosts (a new `{{local_domain}}` registry placeholder) follow the configured domain instead of a hard-coded `local.sandbox.com`. SW-11 removes the old-name fallbacks.
- 746524a: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.

## 0.35.5

## 0.35.4

### Patch Changes

- ce9e540: SW-90: `close-out` is safe when two runs overlap. `closeOut` takes a per-workspace lock, so a second run says `close-out of '<name>' is already running` right away. A run that finds the folder already gone, at the start or by the `closeout.md` write, says the workspace is already closed out instead of throwing ENOENT. `sandbox close-out` without `--yes` and without a terminal refuses at once ("needs --yes when not run from a terminal"). Before, it read an empty stdin and exited 130 after the prompt with no message. Any no-TTY prompt that runs out of input now says so before it exits.

## 0.35.3

### Patch Changes

- 14aa6e8: The PR gate's on-demand start no longer asks compose for a service id only the branch registry knows: when a branch has renamed a service (e.g. `sandbox-core` → `werkmeister-core`) but the machine registry, and so `compose.yml`, still uses the old id, the gate starts the compose service that owns the same path, tests through it, and notes the drift with a pointer to `werkmeister registry` (SW-87).

## 0.35.2

## 0.35.1

### Patch Changes

- 5ba440a: The PR gate's on-demand service start no longer aborts a cold workspace with `docker compose failed (exit 130)` (SW-86). The 300 s compose timeout was firing while `up -d --wait <svc>` waited on the setup container's install and build. Compose catches the timeout's SIGTERM and exits 130, which `runAsync` took for an ordinary exit. `runAsync` now reports any kill by its own timer as a timeout. `sandbox up` and the gate's service start get a 20-minute budget, and the timeout message states the real budget. A failed start also names the state the container was left in, e.g. `Failed to start cli (left created)`.

## 0.35.0

### Minor Changes

- 5bc1a35: A spike workspace can now open a PR for a deliverable in a code repo, such as a write-up in `docs/research/` (SW-83). A template with no propose stage keeps its PR files in its last stage's `output/` (`stages/02_findings/output/pr-<repo>.md`), so `werkmeister pr gate`, `pr open`, `pr adopt` and close-out work for a spike the same as for any workspace. Spikes now get `_shared/pr-rules.md`, and the findings stage says when to write a PR file. A spike with no PR file closes out as before. A PR file can set `skip_exercise: <reason>` to skip the gate's exercise check when there is nothing to run. With no PR file, `pr gate` / `pr open` say which file to write, where the format is, and that the person approves it. The PR guard now denies only a real `gh pr create` at the start of a statement; the phrase inside quotes, a heredoc body or a grep pattern no longer trips it.

## 0.34.0

### Minor Changes

- 2f92c5f: Remove the SW-9 plugin-rename compatibility shims (SW-23). The old plugin path plugins/sandbox-tools, the link that let `CLAUDE_CODE_PLUGIN_DIRS` installs keep loading the plugin under its old path, is gone: point the setting at `.../plugins/werkmeister`. Generated permission rules no longer allow or deny the `mcp__plugin_sandbox-tools_sandbox-workspace__` prefix, and existing workspaces drop those rules on their next refresh. `.mcp.json` generation no longer deletes a leftover `sandbox` MCP entry from before the rename: remove it by hand if it is still there. `w9r setup` still retires an old `sandbox-tools@sandbox` install. The dashboard's old sandbox-connect tool was already renamed `connect` in SW-48 (0.21.0), so no new Cowork reinstall is needed; an artifact installed before 0.21 still calls the old name and needs `werkmeister:install-workspace-dashboard` run again.

### Patch Changes

- d26e6ae: Check `{@link}` references in core's comments with TypeDoc in CI, and fix the broken `resolveSandboxBin` link in `claude_cli.ts`.

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.0

### Minor Changes

- 0c00bdd: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

## 0.29.0

## 0.28.1

### Patch Changes

- fecad45: SW-66: `createWorkspace` and `initWorkspace` take `build: false` to skip the image build, so the core suite's create test no longer leaves a crash-looping `demo-backend` container and `demo` slot on the real Docker daemon.

## 0.28.0

## 0.27.0

## 0.26.1

## 0.26.0

### Minor Changes

- 0735db5: SW-12: start an intercept from the Workspaces pane when Telepresence is installed but not connected.

  - **Snapshot.** `sandbox status --intercepts --json` gains `installed`: true whenever the binary is on PATH, connected or not. `available` keeps its meaning (the daemon answered). When installed but disconnected, the snapshot now carries the rows, every one `intercepted: false`.
  - **No daemon launch on a poll.** The intercept read runs `telepresence status` first and `list -i` only against a connected daemon. Before this, every poll's `list` implicitly connected, launching a user daemon each time.
  - **Pane.** Installed but disconnected, an interceptable service shows `Intercept`. Its confirm line adds "Connects telepresence (docker) first." The pane starts and leaves intercepts in docker mode (`connect --docker`), since it has no TTY for host mode's sudo prompt. Not installed still reads `intercepts unavailable`. A core older than this falls back to `available`.
  - **Two daemons.** Any unqualified telepresence call can start a host user daemon beside the docker one, and telepresence then refuses unqualified commands. Docker-mode connect checks, intercepts and leaves (detach, agent uninstall, quit) now pass `--use <context>-<namespace>-cn`. The snapshot reads whichever daemon is connected.
  - **CLI / VS Code.** `sandbox status --intercepts` prints "not connected — `sandbox intercept` connects first." plus the rows. `sandbox intercept --leave --docker-daemon` leaves through the docker daemon. The VS Code tree keeps a disconnected service interceptable, noting "telepresence not connected".

  Core API:

  - `InterceptState` gains `installed` and `namespace`; `InterceptsSnapshot` and `InterceptsResult` gain `installed`.
  - New `dockerDaemonName()`; `LeaveInterceptArgs` gains `dockerDaemon`.

## 0.25.0

### Minor Changes

- 92f3b4a: SW-42: shared infra only when a workspace needs it.

  - **k8s-forwards.** `sandbox up` checks or restarts the shared k8s-forwards container only when a local service needs the cluster. A service needs it when it has a `k8s_deployment`, an environment value naming a `k8s-*` alias or a `{svc}` ref to a non-local service, or a non-local `depends_on`. A werkmeister-only `up` (cli, library or extension services) no longer touches it.
  - **Caddy.** `up` starts Caddy only for routed or cluster-backed workspaces. When Caddy is already running, `up` still reloads it.
  - **Network.** `up` and the gate's on-demand start create the `sandbox-shared` network when it is missing.
  - **jaeger and redisinsight.** They still start only from `sandbox connect` / `sandbox up infra`.
  - **Telepresence.** Leaving an intercept, whether with `sandbox intercept --leave`, the MCP `intercept` leave or `sandbox down`, now uninstalls the traffic agent of each workload no other intercept still uses. It quits the local daemons when no intercept remains. If the intercept list can't be read, it does neither.

  Core API:

  - new `needsCluster()` (config), `ensureSharedNetwork()` (caddy), and `releaseIdleTelepresence()`, `buildUninstallArgs()` and `buildQuitArgs()` (telepresence);
  - `UpResult.caddy` gains `"skipped"`.

## 0.24.1

## 0.24.0

### Minor Changes

- 3fc5287: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.
- 5886cc5: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- 3c1a49a: Create form (SW-51): Work type and Workflow are preselected on every GUI, labels drop the terminal hints ("blank to skip", "Enter for default") and follow docs/ui-spec.md, VS Code's New Workspace runs the wizard from the workspaces root instead of ~, and the terminal wizard requires at least one service or repo.
- 20f67e7: SW-65: the `check-in` MCP tool reports each workspace's `lifecycle` and `prs` (repo, url, status, `release`), and names the shipped or abandoned workspaces with no Claude turn working as `readyToClose`. Before reporting, it ships merged PRs a release tag now contains, with the same rule and code as `werkmeister pr status` and no `gh` call.

## 0.23.0

### Minor Changes

- 050e037: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

## 0.22.0

### Minor Changes

- 58a61bd: `stop` and `restart` for a feature, for infra and for Caddy now go through the Docker Engine API instead of `docker compose stop`/`restart`. Containers are handled in `depends_on` order: dependents stop first, and dependencies start first. `restart` no longer re-runs a finished setup container. A failure names the container and the daemon's message. `composeStop`, `composeRestart` and `stopCaddy` are now async (SW-60).

### Patch Changes

- 3fdbf6d: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.

## 0.21.0

### Minor Changes

- 084b453: `werkmeister pr gate` starts one container for a touched repo that has none running, runs the tests through it, and stops it again, pass or fail. Containers that were already running are left alone. compose.yml now also lists the checked-out repos' other services behind the `on-demand` profile, which a plain `up` skips. `stop` and `down` include that profile. The gate's baseline check covers only api/web services. A workspace no longer needs every service listed to pass the gate (SW-34).
- e4adda8: Agent state tells Done, Needs you and Working apart (SW-46). Every workspace now gets a `werkmeister hooks agent-state` hook on UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd. The hook records `{state, at, question?}` in `.werkmeister/agent-state.json`. `getWorkspaceStatuses()` returns `claude.agent` (`working` · `needs-you` · `done` · `idle`), `claude.at` and `claude.question` in place of `claude.waiting`, and falls back to the transcript tail when a workspace has no state file yet. Existing workspaces pick up the hooks on their next `werkmeister up`. The workspaces pane and the dashboard show `◌ Working`, `● Needs you` and `✓ Done`, so a finished run no longer reads "waiting for you".

## 0.20.0

### Minor Changes

- afc375a: Every generated workspace container gets a CPU limit (`cpus` 1.0, 2.0 for setup services such as sandbox-install), overridable per service, setup service or `extra_services` entry with `cpus:` in services.yaml. `werkmeister stats` and `werkmeister optimize` show each container's CPU limit (SW-40).

## 0.19.0

### Minor Changes

- 0ec96f9: `werkmeister setup` offers to schedule `werkmeister pr watch` every 10 minutes (launchd on macOS, crontab elsewhere); `werkmeister pr watch --install` / `--uninstall` add or remove it. Logs go to `~/.werkmeister/pr-watch.log` (SW-14).

## 0.18.0

### Minor Changes

- 8a0c8b4: `getWorkspaceStatuses()` returns every workspace-card field: ICM `stage`, JIT `phase`, `autonomous`, `autoStop` and `lastActivity`, next to the existing per-service health and `model`. `getWorkspacePRs()` returns `ci` (`pass` · `running` · `fail`) and `failingChecks` per PR from `statusCheckRollup`. New exports `icmStage()` and `ciOf()`; the pane now reads the stage from core (SW-47).

### Patch Changes

- 963da69: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- 28e39b6: `sandbox pr watch` now resumes terminal sessions that ran `sandbox pr open` from a code worktree or other subfolder. `pr open` records the session's start folder (`session_cwd`, from its transcript), and delivery looks the session up and runs `claude -p --resume` from there. It still never falls back to another session.
- cfea47d: The built-in compose fallback now names feature containers `<feature>-<svc>`, as the template does, instead of `sandbox-<feature>-<svc>`. Both paths and the PR gate's container lookup share one `containerOf(feature, svc)`, so a workspace generated through the fallback has containers the gate, restart lines and allow rules can find.

## 0.17.1

## 0.17.0

### Minor Changes

- 8c2a1eb: The workspaces MCP server has a new `check-in` tool: the check-in skill's triage in one call. It returns every workspace's labels, container and Claude state, proposed stage gates, and whether its transcript changed since the last check-in, filtered by `skip` / `focus`, plus the `candidates` that need a courier, and marks the check-in time in `<root>/.check-in-last`. It returns plain JSON, so a check-in no longer renders the workspaces table inline the way `list-workspaces` does.

## 0.16.0

### Minor Changes

- 4e08dd6: The workspace's issue now moves by itself as the work does (SW-27, SW-24). `sandbox issue start`, run by the first ICM stage and JIT's `sb-research`, moves it to In Progress. `sandbox pr open` moves it to In Review. `sandbox pr status` moves it back to In Progress when a review asks for changes or a PR closes unmerged, and to Done once the work ships; close-out is the safety net. `close-out --abandon` comments the reason, applies `abandoned` when configured, and on GitHub closes the issue as not planned. Configure the statuses with `overrides.issue_statuses: { in_progress, in_review, merged, done, abandoned }` (null skips a point); `issue_review_status` and `issue_done_status` still work. Moves are forward only, post a comment naming the trigger, and a tracker refusal is a warning that never fails a stage, PR open or close-out. On GitHub, a `status:` label replaces the issue's other `status:` labels.
- fe14381: Service containers of type `cli`, `library` and `extension` now idle by default (SW-32): `sleep infinity` under `init: true`, `restart: on-failure:3`, and no always-passing healthcheck, so an idle workspace uses almost no CPU or memory and `sandbox stop` returns fast. Their `command:` watchers run with `sandbox up --dev` (or `SANDBOX_DEV=1 docker compose up -d`). A service that depends on one of them waits for `service_started`. `sandbox up` now regenerates a `compose.yml` that predates the current template or registry instead of only warning, so existing workspaces drop their watchers on their next `up`. The generated ICM reload lines say to `docker exec` into idle services rather than restart them.
- 88fb0e3: Feature containers no longer keep running after a PR (SW-39).
  - `werkmeister pr open` stops the workspace's feature containers once a pass opens a PR and nothing in it failed. `werkmeister pr status` does the same when it records a PR as merged or shipped. Slot and volumes are kept, so `werkmeister up` resumes.
  - The new `werkmeister stop --idle <minutes> [feature]` stops each feature nothing has used for that many minutes. Use means a busy Claude session in the workspace (or one that became idle less than N minutes ago), a container started in that time, or a gate `docker exec`, which the gate now records in `.werkmeister/last-exec`.
  - Every PR watch pass, from the werkmeister mod's timer or from `werkmeister pr watch`, ends with one reaper pass. Its N comes from `overrides.idle_stop_minutes`: 30 by default, `0` for off.
  - `auto_stop` is now on by default for `autonomous` workspaces, and `auto_stop: false` still turns it off. The create form's unticked box no longer writes `auto_stop: false` into a new workspace.

### Patch Changes

- 7035cff: Docs sweep for the Werkmeister rename (SW-10). The README and `docs/` now call the tool Werkmeister, show `werkmeister` (or `w9r`) in every command, and use `~/.werkmeister` and `<workspace>/.werkmeister/`, with a note that the old `~/.sandbox` and `.sandbox/` are still read. The clone steps no longer `cd sandbox`. No behaviour change. The `sandbox` bin, `SANDBOX_*` variables, container names and a repo's `.sandbox/services.yaml` fragment keep their names.
- 183a2e9: The workspace router row for a merged or released PR now says to run `sandbox pr status`, then ask the person before `sandbox close-out`, instead of reading like permission to close out right away (SW-13). The ICM propose-stage contract and JIT's `sb-pr` skill use the same wording. Existing workspaces get it on their next `sandbox init-workspace`.
- 7d121e8: `sandbox pr gate` (and `pr open`) now tests a branch with its own `.sandbox/services.yaml` fragment: the gated repo's `test:` commands and path mappings come from the worktree, every other repo and the `services.local.yaml` overlay as `registry sync` builds them. A PR that renames packages and updates its own test filters can pass its gate without a machine-wide override, and the shared `~/.sandbox/services.yaml` is not touched (SW-25).
- 4240fba: `werkmeister up` no longer fails when the kube context exists but its cluster is switched off. The k8s port-forwards are skipped with a warning when the API server doesn't answer, so features that need nothing from the cluster come up normally (SW-28).

## 0.15.0

### Minor Changes

- dba74e3: Rename the Claude Code plugin `sandbox-tools` to `werkmeister` and its marketplace `sandbox` to `werkmeister` (install id `werkmeister@werkmeister`). The seven `sandbox-*` skills drop the prefix (`/werkmeister:diagnose`, `:workspace`, `:feature-test`, `:status`, `:caddy-reload`, `:routing-test`, `:starting-prompt`). The plugin's MCP server `sandbox-workspace` is now `workspaces` and runs `w9r dashboard`, so its tools are `mcp__plugin_werkmeister_workspaces__*`. The headless registry server `sandbox` is now `werkmeister`, and its tools drop the prefix (`sandbox-up` is `up`, `sandbox-status` is `status`, `sandbox-workspace` is `workspace`, and so on). The dashboard's `sandbox-connect` tool keeps its name.

  An existing install does not move by itself. Run `w9r setup`: it installs the new plugin, then removes `sandbox-tools@sandbox` and the `sandbox` marketplace (`w9r setup --check` flags the old one). `plugins/sandbox-tools` stays as a link to the new directory for one release, and generated permission rules allow both the old and new tool prefixes for one release. Manual steps, including Claude Desktop, are in `plugins/werkmeister/README.md`.

## 0.14.1

## 0.14.0

### Minor Changes

- ccdb6a0: The Caddy feature selector is now served at `/__werkmeister` (SW-8). `/__sandbox` keeps working as an identical, deprecated alias until SW-11 removes it. The `X-Feature` cookie and header are unchanged.
- 192c2f2: `sandbox pr open` no longer moves the issue to a hardcoded "In Development". It moves it to `overrides.issue_review_status` from `~/.sandbox/config.yaml`, defaulting to "In Review", which matches the usual To Do → In Progress → In Review → Done workflow. On GitHub, the label of that name is added as before.
- 5e11f2a: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- cc2806e: The GitHub repository is now `jbbz-sandbox/werkmeister` (SW-10). The package's repository URL, the sandbox-tool issue repo in generated issue-filing guides, the plugin marketplace source written by `setup`, the schema `$id`s and the docs all point there. GitHub redirects the old `jbbz-sandbox/sandbox` URLs, so existing clones and links keep working.

## 0.13.0

### Minor Changes

- d5b1a9a: Narrow the `autonomous` permission rules to the workspace's own feature. `Bash(sandbox|docker|npm|gh:*)` and the whole sandbox-workspace MCP server give way to per-command rules (`sandbox up|restart|logs|test <feature>`, `docker exec|logs|restart <feature>-<svc>`, `npm ci|run|test`, read-only `gh` and MCP tools), and a recorded `permissions.deny` blocks `sandbox proxy-reload|down|remove-workspace`, `docker stop|rm`, `npm publish|link` and global installs, `gh pr merge`, and the cross-workspace MCP tools. Rerunning `init-workspace` or `sandbox up` replaces the old rules.

## 0.12.0

### Minor Changes

- aba829c: PR callbacks (#236): `sandbox pr open` records the Claude Code session that opened each PR (`session`, plus `host_session` in the desktop app), and that session is told once when the PR merges, ships or closes. Desktop sessions are reached through the app by the sandbox-tools mod, which checks every 10 minutes; terminal sessions are resumed headlessly by the new `sandbox pr watch` (run it from cron). It never merges or closes out.

## 0.11.0

### Minor Changes

- 2f106fc: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).

## 0.10.1

### Patch Changes

- da18100: `sandbox up` no longer exits mid-run with Node's "unsettled top-level await" warning while waiting for restarted k8s port-forwards. The redis/postgres probe now treats a peer that hangs up without replying (Docker's port proxy before the tunnel binds) as down instead of waiting forever, so the wait either sees the forwards return and goes on to start the containers, or fails with `FORWARDS_NEVER_READY` (#207). `sandbox status --k8s` and the dashboard's forwards check share the probe and can no longer hang the same way.

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

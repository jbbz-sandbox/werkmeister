# @jbbz-sandbox/sandbox-cli

## 0.38.1

### Patch Changes

- ee2e2dd: SW-98: the CLI README and `main.ts` header no longer say Werkmeister runs "up to 12" features. Twelve is the default for `feature_slots.count` in `ports.yaml`, not a limit. How many features you can run at once depends on how many services each one runs locally and how much RAM you have.

## 0.38.0

### Minor Changes

- fa40827: SW-99: the `install-workspace-dashboard` skill is gone, along with the live-artifact build of the workspace dashboard (`workspace-list.artifact.html`). The workspaces UI is unchanged on the other surfaces: the localhost dashboard (`open-workspaces-ui`), the Claude Code mod and the Claude Desktop MCP App. If you installed that artifact, delete it and use the Desktop MCP App or the localhost dashboard instead.

## 0.37.1

### Patch Changes

- 3c9e892: SW-100: Caddy starts on a fresh clone, a git worktree or an npm install. The generated `features.json` was file-bound inside the read-only `proxy/ui` mount, so Docker needed a gitignored `apps/cli/infra/proxy/ui/features.json` to exist as the mountpoint, and only old checkouts with a stale copy had one. It now mounts at `/srv/features.json`, and the Caddyfile's `/__werkmeister/features.json` handle serves it from there. The next `connect` / `up infra` regenerates the Caddyfile and recreates Caddy on the new mount. A leftover `apps/cli/infra/proxy/ui/features.json` in an old checkout is no longer read and can be deleted.

## 0.37.0

### Minor Changes

- 59ae387: SW-95: the shared-infra stack no longer says "sandbox". The compose project is `w9r-infra`, the containers are `w9r-caddy` and `w9r-k8s-forwards`, and Caddy's volumes are `w9r-infra_caddy-data` / `w9r-infra_caddy-config`. The dashboard's Jaeger and RedisInsight links point at `*.w9r-infra.orb.local`. On a machine still running the old `sandbox-infra` stack, the next `connect` / `up infra` takes it down first (its containers hold the names and ports 80/443 the new one needs) and then starts the renamed stack, so the proxy restarts once. `down infra` takes the old stack down too. Its volumes are kept unless you pass `--volumes`. Leftover `sandbox-infra_*` volumes can go with `docker volume rm`. An opted-in RedisInsight starts with empty settings, because its volume moves to the new project. Caddy's data is safe to lose: certs are bind-mounted from `certs_dir`.

## 0.36.2

### Patch Changes

- d99ca2a: In a checkout, `werkmeister mcp` now runs `apps/werkmeister-mcp/dist/main.js`. The wrapper still pointed at the MCP app's pre-rename folder. On a fresh clone that fell through to the bundled `dist/mcp.js`, but a checkout that still held an old untracked build under the pre-rename name ran that stale build, which crashed on `werkmeister-core/config` and left the werkmeister plugin's MCP server unable to connect.

## 0.36.1

### Patch Changes

- b5bec68: SW-97: `werkmeister migrate` no longer tells the person to run an `infra` subcommand, which doesn't exist. The refusal while shared infra is running now names `werkmeister down infra`, and the success message names `werkmeister connect`. A new test fails the build if any backticked `werkmeister …` command in migrate's messages isn't a registered CLI command.

## 0.36.0

### Minor Changes

- eabd324: SW-93: the Docker-side names and default domains no longer say "sandbox". New containers carry `com.werkmeister.*` labels, compose projects and per-feature networks are `werkmeister-<feature>`, features join the `werkmeister-shared` network, the built-in build caches live in `werkmeister-<key>` volumes, and the sandbox repo's setup service is `werkmeister-install`. A workspace brought up before this keeps running under its old `sandbox-<feature>` project and `com.sandbox.local.*` labels: slots, `status`, `stop`, `restart`, `logs`, the VS Code tree and the idle reaper all still find it, and its next `up` takes the old project down (keeping its node_modules volumes) before starting the new one. `down` and `close-out` remove both. Caddy and k8s-forwards join both shared networks, and `cache prune` also reaches a leftover `sandbox-<key>` volume. A fragment still naming its setup `sandbox-install` gets the renamed startup script. The default `local_domain`/`remote_domain` are now `local.werkmeister.io`/`remote.werkmeister.io`; a machine whose `config.yaml` sets them (every `setup` run writes them) keeps its own. The X-Feature cookie, the `connect` tool links and the docs-site's allowed hosts (a new `{{local_domain}}` registry placeholder) follow the configured domain instead of a hard-coded `local.sandbox.com`. SW-11 removes the old-name fallbacks.
- 746524a: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.

### Patch Changes

- b55bac1: A merge to main that changes only docs (`.md` files, or the docs-site app) now deploys werkmeister.io in the same CI run instead of waiting for the next package release (SW-96).

## 0.35.5

### Patch Changes

- c4e3898: Close-out's handoff no longer commits untracked files (SW-91). It commits tracked changes only. Untracked files that `.gitignore` misses, such as a container's build cache, are saved to `handoff/<workspace>/<repo>.tgz` in the werkmeister home (`~/.werkmeister`, or `~/.sandbox` on an older machine) instead of being pushed. The close-out output shows each handoff commit's `--stat` and lists the files it kept. `close-out --abandon` no longer pushes a code branch that has no commits of its own; it saves the handoff commit as a `.patch` beside the tarball.

## 0.35.4

### Patch Changes

- ce9e540: SW-90: `close-out` is safe when two runs overlap. `closeOut` takes a per-workspace lock, so a second run says `close-out of '<name>' is already running` right away. A run that finds the folder already gone, at the start or by the `closeout.md` write, says the workspace is already closed out instead of throwing ENOENT. `sandbox close-out` without `--yes` and without a terminal refuses at once ("needs --yes when not run from a terminal"). Before, it read an empty stdin and exited 130 after the prompt with no message. Any no-TTY prompt that runs out of input now says so before it exits.

## 0.35.3

### Patch Changes

- 0bff492: The docs site is served at https://werkmeister.io instead of https://jbbz-sandbox.github.io/werkmeister/ (SW-88).

## 0.35.2

### Patch Changes

- 31c8c3d: Re-running the `docs-deploy` CI job no longer fails with "Multiple artifacts named "github-pages"": each attempt uploads the site under its own artifact name (SW-80).

## 0.35.1

### Patch Changes

- ca7d771: SW-81: a hidden `werkmeister __reference` prints the commands and options as JSON. `pnpm run docs:gen` builds the users-guide command list from it, and `docs:check` reads it for the flag check.
- 77f45bf: The public docs now build as a VitePress site (`apps/docs-site`) from the docs where they live, and deploy to GitHub Pages at https://jbbz-sandbox.github.io/werkmeister/ when a release publishes (SW-80). A broken doc link fails the site build. The README links to the site, explains `demo-services`, and `docs/jira-rest-setup.md` reads as a how-to.

## 0.35.0

## 0.34.0

### Minor Changes

- 2f92c5f: Remove the SW-9 plugin-rename compatibility shims (SW-23). The old plugin path plugins/sandbox-tools, the link that let `CLAUDE_CODE_PLUGIN_DIRS` installs keep loading the plugin under its old path, is gone: point the setting at `.../plugins/werkmeister`. Generated permission rules no longer allow or deny the `mcp__plugin_sandbox-tools_sandbox-workspace__` prefix, and existing workspaces drop those rules on their next refresh. `.mcp.json` generation no longer deletes a leftover `sandbox` MCP entry from before the rename: remove it by hand if it is still there. `w9r setup` still retires an old `sandbox-tools@sandbox` install. The dashboard's old sandbox-connect tool was already renamed `connect` in SW-48 (0.21.0), so no new Cowork reinstall is needed; an artifact installed before 0.21 still calls the old name and needs `werkmeister:install-workspace-dashboard` run again.

### Patch Changes

- cf3bda0: `sandbox-install` installs again when a workspace is re-created under the same feature name on its kept `node-modules` volume (SW-85). Each package's own `node_modules` lives in the worktree, not the volume, so the SW-33 skip now needs a second copy of its stamp in the worktree (`.turbo/.sandbox-install-hash`) to match as well. A re-created worktree, or a dropped volume, reinstalls; the build no longer fails on missing per-package deps, and `down -v` is no longer needed first. With both intact and the lockfile unchanged the install is still skipped. Each existing workspace reinstalls once on its first up after this change.

## 0.33.2

### Patch Changes

- c12dd11: `werkmeister status`, the Workspaces pane and the dashboard show a stopped k8s-forwards container as neutral ("stopped — not needed by any running workspace") when no running workspace has a cluster-backed local service. Since SW-42 `up` starts the forwarder only for such workspaces, so on a werkmeister-only machine it is stopped by design. While a running workspace needs it, a stopped forwarder still shows red with the `docker restart sandbox-k8s-forwards` hint. `k8s-forwards-status` gains a `stopped` flag, and the infra tally leaves out a forwarder nothing needs, so infra no longer reads partial.

## 0.33.1

### Patch Changes

- e254a0d: `werkmeister issue create` and `issue update --comment` convert Markdown to Jira wiki markup before sending it through Jira REST, so headings, lists, bold, code spans, fenced blocks and links render in Jira. Before, `## Ask` turned into a numbered list and `**bold**` stayed literal.

## 0.33.0

### Minor Changes

- 4a86ff1: Breaking for Node 20 and 21 (SW-77). The supported minimum is now Node 22: `engines` says `>=22` (Node 20 has been EOL since 2026-04), the bundles target `node22`, and a feature container with no `image:` defaults to `node:22` instead of `node:20.16.0`. Set `image:` in `services.yaml` to keep a different one. Upgrade the Node that runs the CLI to 22 or later (`brew upgrade node`, or `nvm install 22`).

## 0.32.0

### Minor Changes

- 002e175: Graduation works in icm workspaces (SW-72). Each context strategy now supplies its own decisions. In icm they are the `status: decided` sections of `stages/*/output/*.md`, one per heading, with id `stages/<stage>/output/<file>.md#<heading-slug>`. `werkmeister notes graduate`, the `werkmeister down` offer and the MCP `notes` `graduate` action scaffold them through the same `graduateNote` path jit uses. Their `graduating → graduated` state is kept in `.werkmeister/graduations.yml`, so the stage outputs are never rewritten. MCP `notes` `list` also returns the open `decisions`. jit is unchanged. The not-in-workspace error no longer names the old `.sandbox/` directory.
- 22541a5: Redis Insight and Jaeger no longer start with shared infra (SW-76). Redis Insight is SSPL-1.0, so it shouldn't start for everyone, and nothing in Werkmeister sends traces to Jaeger. To turn either or both back on, add their profiles to `~/.werkmeister/config.yaml` and run `werkmeister connect`:

  ```yaml
  infra:
    profiles: [redisinsight, jaeger]
  ```

  `COMPOSE_PROFILES=redisinsight werkmeister connect` works for a one-off. Containers already running from an earlier release stay up until `werkmeister down infra`, which now removes the opt-in ones too.

### Patch Changes

- 4b2d289: Stop shipping `infra/compose/scripts/otel-init.bundle.js`, a 2.6 MB third-party bundle with no source or licence texts that nothing referenced.
- d83f887: PR rules: squash is the default merge; a PR whose commit SHAs must survive (e.g. a `.git-blame-ignore-revs` entry) asks for a merge commit at the top of its body. `pr open` warns when the branch adds a blame-ignore SHA.
- 3b36893: SW-73: `@anthropic-ai/claude-agent-sdk` is now an optional dependency. `detect --assist` prints the install command when it is missing instead of a module-resolution error.

## 0.31.0

### Minor Changes

- d4e9e00: Breaking for workspaces of the werkmeister repo itself (SW-30). Its directories now match their package names (`apps/werkmeister-mcp`, `apps/werkmeister-dashboard`, `packages/werkmeister-core`, `packages/werkmeister-ui`, `packages/werkmeister-vscode`), and the services in its registry fragment follow. `sandbox-core` is now `werkmeister-core`, `sandbox-dashboard` is `werkmeister-dashboard`, and `vscode-plugin` is `werkmeister-vscode`, so containers are named `<feature>-werkmeister-core` and so on. `cli` and `apps/cli` are unchanged, so the global link and `sandbox_root` still work. There is no alias for the old ids. To migrate a workspace:

  - Run `werkmeister down <feature>` before you pull this release. If you've already pulled it, remove the leftover `<feature>-sandbox-core`, `-sandbox-dashboard` and `-vscode-plugin` containers with `docker rm -f`.
  - Run `werkmeister registry sync` from the updated main checkout. Then rename those three keys in `services.local.yaml` (in `~/.werkmeister/`, or `~/.sandbox/` on older machines) and in any `services:` list or `--services` value that names them.
  - The dashboard's host is now `werkmeister-dashboard.local.sandbox.com`. Run `werkmeister setup` from the main checkout to add it to `/etc/hosts`.
  - In a checkout, run `pnpm install` after pulling, so the workspace links follow the moved directories.

## 0.30.0

### Minor Changes

- 0c00bdd: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

## 0.29.0

### Minor Changes

- c4f313a: Build and package caches are registry data (SW-69). A `caches:` entry gives a cache's container path, the env that points the tool at it, the lockfiles that attach it and an age or prune rule; `turbo` and `pnpm-store` are built in, and a repo can add its own. `up` creates only the shared volumes a workspace mounts, `werkmeister status` lists each cache's size and age, and `werkmeister cache prune [name]` (`--reset`, `--dry-run`, `--force`) clears them. The turbo cache moves from `~/.sandbox/cache/turbo` to the shared `sandbox-turbo` volume.

## 0.28.1

## 0.28.0

### Minor Changes

- 421c020: The plugin's skills no longer need Python. `sandbox starting-prompt` prints the enclosing workspace's `starting_prompt` (exit 1: no `workspace.yml` found, 2: none set; `--start <dir>` to search from elsewhere) and replaces the starting-prompt skill's `get_prompt.py`. `sandbox test <feature> --scaffold` writes `playwright.config.ts` and `<feature>.spec.ts` into the workspace if missing and installs the pinned `@playwright/test`, replacing the feature-test skill's `setup_feature.py`; `--workspace` and `--base-url` carry over. Both reuse the CLI's own config, ingress and slot lookups, so the Playwright version and ingress host no longer have a second copy to keep in step.

### Patch Changes

- c6166d2: Autonomous workspaces now allow and deny `werkmeister …` and `w9r …` commands the same as `sandbox …`. The rules were written only for the deprecated `sandbox` launcher, and a permission rule is a literal prefix, so a run calling `werkmeister up` stalled waiting for approval while `werkmeister down` slipped past the deny list. The MCP deny list no longer names `remove-workspace`, which the server dropped in #160. Rerun `init-workspace` (or `werkmeister up`) in an autonomous workspace to pick up the new rules.
- 7e55150: The Workspaces pane finds `werkmeister-core` when the CLI is installed with `pnpm link --global`. pnpm's global bin is a shell shim outside the package, so the pane failed with `Cannot find module 'sandbox-core'`; it now also looks under pnpm's global folder, and the error names `WERKMEISTER_CORE_PATH` when neither works.

## 0.27.0

### Minor Changes

- 769d9f4: A services-registry `extra_volumes` entry can now name one Docker volume that every feature shares: write it with a leading `^` (`^sandbox-pnpm-store:/pnpm-store`). Each feature's compose mounts it unprefixed and declares it `external`, and `sandbox up` creates it if it is missing, so a package-manager store or cache is warm in every workspace. No feature's `down --volumes`, close-out or `clean` removes it; drop it with `docker volume rm <name>`. Bare names stay per-feature (`<feature>-<name>`).

## 0.26.1

### Patch Changes

- 071af86: Workspaces' generated Claude Code permissions now allow pnpm's build and test commands (`pnpm install --frozen-lockfile`, `pnpm run`, `pnpm test`, `pnpm exec`, `pnpm turbo`) and deny `pnpm publish`, `pnpm link` and global pnpm installs, as they already did for npm. The werkmeister repo itself now builds with pnpm; installing the CLI (`npx werkmeister setup`, `npm install -g werkmeister`) is unchanged.

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

### Patch Changes

- 3172434: `werkmeister connect` works with Docker Compose v5. Compose now builds through `buildx bake`, which refused the k8s-forwards image's `corp-ca.crt` secret because it sat outside the directory compose ran from. Shared-infra compose commands now run from the config directory that holds the secret (`~/.werkmeister`, or `~/.sandbox` on older setups). When shared infra fails to start, `connect` now says so and exits 1, instead of printing "All 1 services healthy" for the containers that happened to exist.

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

### Patch Changes

- fedf530: A workspace card waiting on an `AskUserQuestion` now shows the question itself instead of "Claude needs your permission to use AskUserQuestion".
- ec26a3e: Workspace cards no longer read Done when a Claude Desktop run is waiting on you. The agent-state hook now records a `wrap_up` box's question as needs-you, even when the closing message after it asks nothing.

## 0.24.0

### Minor Changes

- 3fc5287: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.

### Patch Changes

- 3c1a49a: Create form (SW-51): Work type and Workflow are preselected on every GUI, labels drop the terminal hints ("blank to skip", "Enter for default") and follow docs/ui-spec.md, VS Code's New Workspace runs the wizard from the workspaces root instead of ~, and the terminal wizard requires at least one service or repo.

## 0.23.0

### Patch Changes

- 050e037: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

- 2403e01: Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` (the licence text of every package bundled into `dist/`) in the published package. The licence of every npm dependency is now checked against an allowlist in CI (`npm run licenses`); the full inventory is `docs/third-party.md`.

## 0.22.0

### Patch Changes

- f86aa7c: `overrides.issue_progress_status` now sets the status `issue start` moves the issue to, like `issue_review_status` and `issue_done_status` (`issue_statuses.in_progress` still wins). The workspace and sb-pr skills describe the full To Do → In Progress → In Review → Done flow.
- 7b077fc: The sandbox repo's containers now share one turbo build cache at `~/.sandbox/cache/turbo` (`TURBO_CACHE_DIR`), so a commit any workspace has built restores in about a second in every install and gate run. Before, the cache sat in the main checkout's `.turbo` and the install container missed it. `TURBO_CACHE_MAX_AGE=14d` bounds the cache, and installs build one at a time so concurrent writers can't collide. Run `werkmeister registry` to pick up the new settings. The old `~/repos/sandbox/.turbo` can be deleted by hand.
- 58a61bd: `stop` and `restart` for a feature, for infra and for Caddy now go through the Docker Engine API instead of `docker compose stop`/`restart`. Containers are handled in `depends_on` order: dependents stop first, and dependencies start first. `restart` no longer re-runs a finished setup container. A failure names the container and the daemon's message. `composeStop`, `composeRestart` and `stopCaddy` are now async (SW-60).
- 3fdbf6d: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.

## 0.21.0

### Minor Changes

- 084b453: `werkmeister pr gate` starts one container for a touched repo that has none running, runs the tests through it, and stops it again, pass or fail. Containers that were already running are left alone. compose.yml now also lists the checked-out repos' other services behind the `on-demand` profile, which a plain `up` skips. `stop` and `down` include that profile. The gate's baseline check covers only api/web services. A workspace no longer needs every service listed to pass the gate (SW-34).
- e4adda8: Agent state tells Done, Needs you and Working apart (SW-46). Every workspace now gets a `werkmeister hooks agent-state` hook on UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd. The hook records `{state, at, question?}` in `.werkmeister/agent-state.json`. `getWorkspaceStatuses()` returns `claude.agent` (`working` · `needs-you` · `done` · `idle`), `claude.at` and `claude.question` in place of `claude.waiting`, and falls back to the transcript tail when a workspace has no state file yet. Existing workspaces pick up the hooks on their next `werkmeister up`. The workspaces pane and the dashboard show `◌ Working`, `● Needs you` and `✓ Done`, so a finished run no longer reads "waiting for you".

## 0.20.0

### Minor Changes

- afc375a: Every generated workspace container gets a CPU limit (`cpus` 1.0, 2.0 for setup services such as sandbox-install), overridable per service, setup service or `extra_services` entry with `cpus:` in services.yaml. `werkmeister stats` and `werkmeister optimize` show each container's CPU limit (SW-40).
- 634b9cc: One MCP server (SW-48). `werkmeister mcp` now serves every tool, including the dashboard's, over stdio and over HTTP on :3002, with one name per verb and no aliases. The plugin's server is `werkmeister` (tools `mcp__plugin_werkmeister_werkmeister__*`), not `workspaces`. Renamed: `workspace-status` → `status`, `workspace-action` → `up` / `stop` / `restart` / `down`, `sandbox-connect` → `connect`, `open` → `open-feature`, `remove` → `remove-service`, the `workspace` form tool → `create-workspace-form`. Workspace-scoped tools take one `workspace` argument (directory or feature name) in place of `name` / `feature`. `werkmeister dashboard` now runs the localhost browser dashboard and no longer serves MCP. Update a Claude Desktop entry to `{ "werkmeister": { "command": "werkmeister", "args": ["mcp"] } }`.

### Patch Changes

- 221f443: `werkmeister status` and the infra, k8s-forwards and Caddy health checks read containers from the Docker Engine API by compose label instead of shelling out to `docker compose ps` (SW-59). `status` no longer prints a `Running: docker compose … ps` line per feature, so `status --json` is valid JSON again, and it no longer generates the k8s-forwards override as a side effect.
- 6c56866: A service in `services.yaml` can set `dockerfile:` to build its image from a Dockerfile in its `path` (tagged `image:`), instead of only pulling a prebuilt one. The sandbox repo's `vscode-plugin` service uses it to bake in xvfb and Electron's libraries, so `npm run test:integration` runs in a fresh container (SW-62).

## 0.19.0

### Minor Changes

- 0ec96f9: `werkmeister setup` offers to schedule `werkmeister pr watch` every 10 minutes (launchd on macOS, crontab elsewhere); `werkmeister pr watch --install` / `--uninstall` add or remove it. Logs go to `~/.werkmeister/pr-watch.log` (SW-14).

## 0.18.0

### Patch Changes

- 963da69: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- 7768144: Minify the published CLI bundle (`minify: true`, `keepNames: true`) so the package is smaller and loads faster. Function and class names stay in stack traces, third-party license notices stay in the bundle, and `.map` files stay out of the package (SW-58).
- cfea47d: The built-in compose fallback now names feature containers `<feature>-<svc>`, as the template does, instead of `sandbox-<feature>-<svc>`. Both paths and the PR gate's container lookup share one `containerOf(feature, svc)`, so a workspace generated through the fallback has containers the gate, restart lines and allow rules can find.

## 0.17.1

### Patch Changes

- 0ce449c: Adopt the Apache License 2.0 (SW-17): add `LICENSE` and `NOTICE`, and set `"license": "Apache-2.0"` in every package manifest. No behavior change.

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
- 9fc69ae: The sandbox repo's `sandbox-install` setup service no longer reinstalls and rebuilds on every `up` (SW-33). It skips `npm ci` while the lockfile and Node major version match a stamp in the node_modules volume. The stamp is written only after a successful install, so a failed one retries. The service now mounts `~/repos` with `safe.directory`, so turbo restores the build from the main checkout's shared cache. At most `SANDBOX_INSTALL_SLOTS` (default 2) installs run at once host-wide, queued through `~/.sandbox/locks`. Run `werkmeister registry` after upgrading to pick up the new command; until then the old one runs unchanged.
- 4240fba: `werkmeister up` no longer fails when the kube context exists but its cluster is switched off. The k8s port-forwards are skipped with a warning when the API server doesn't answer, so features that need nothing from the cluster come up normally (SW-28).

## 0.15.0

### Minor Changes

- dba74e3: Rename the Claude Code plugin `sandbox-tools` to `werkmeister` and its marketplace `sandbox` to `werkmeister` (install id `werkmeister@werkmeister`). The seven `sandbox-*` skills drop the prefix (`/werkmeister:diagnose`, `:workspace`, `:feature-test`, `:status`, `:caddy-reload`, `:routing-test`, `:starting-prompt`). The plugin's MCP server `sandbox-workspace` is now `workspaces` and runs `w9r dashboard`, so its tools are `mcp__plugin_werkmeister_workspaces__*`. The headless registry server `sandbox` is now `werkmeister`, and its tools drop the prefix (`sandbox-up` is `up`, `sandbox-status` is `status`, `sandbox-workspace` is `workspace`, and so on). The dashboard's `sandbox-connect` tool keeps its name.

  An existing install does not move by itself. Run `w9r setup`: it installs the new plugin, then removes `sandbox-tools@sandbox` and the `sandbox` marketplace (`w9r setup --check` flags the old one). `plugins/sandbox-tools` stays as a link to the new directory for one release, and generated permission rules allow both the old and new tool prefixes for one release. Manual steps, including Claude Desktop, are in `plugins/werkmeister/README.md`.

## 0.14.1

### Patch Changes

- ce5213c: Renamed the internal workspace packages to match the CLI (SW-6): `sandbox-core` is now `werkmeister-core`, `sandbox-mcp` is `werkmeister-mcp`, `sandbox-workspace-mcp-app` is `werkmeister-dashboard`, the root `sandbox` is `werkmeister-monorepo`, and `vscode-plugin` is `werkmeister-vscode`. None is published, and the CLI bundles the core library, so the CLI's behaviour is unchanged. Directories, registry service names and container names keep their old names.

  The VS Code extension id follows its package name: `jbbz.vscode-plugin` is now `jbbz.werkmeister-vscode`. `sandbox setup` looks for the new id, so a machine with the old extension installed gets the new one installed beside it. Uninstall `jbbz.vscode-plugin` by hand.

## 0.14.0

### Minor Changes

- ccdb6a0: The Caddy feature selector is now served at `/__werkmeister` (SW-8). `/__sandbox` keeps working as an identical, deprecated alias until SW-11 removes it. The `X-Feature` cookie and header are unchanged.
- 867da83: Workspaces pane: each running service shows its Telepresence intercept state and an Intercept / Leave toggle (confirm on start). `sandbox status --intercepts --json` now returns an empty `intercepts` list when telepresence is unavailable.
- 26a5300: Renamed the CLI package (formerly `sandbox-cli` under the `@jbbz-sandbox` scope) to the unscoped `werkmeister` (SW-5). It ships two bins, `werkmeister` and `w9r`. The old `sandbox` bin still works but is deprecated: it prints a one-line notice on stderr, then runs as before. It will be removed in SW-11.

  To migrate, uninstall the old scoped package globally, then run `npm install -g werkmeister`.

- ba9e5fa: Sandbox-tool issues can go to Jira: set `overrides.sandbox_issues_project` (e.g. `SW`) under `issue_tracker: jira` and the generated issues guide routes them, and the search step, to that project instead of GitHub (unset keeps GitHub). New `sandbox issue create --project <KEY> --type bug|feature|task --title ... --body-file ...` files a Jira issue over REST and prints its URL; a project without the mapped type (Bug) gets a Task labelled with it. The guide's app-code row under Jira now uses it too. Jira REST errors now include Jira's reason.
- 5e11f2a: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- 192c2f2: `sandbox pr open` no longer moves the issue to a hardcoded "In Development". It moves it to `overrides.issue_review_status` from `~/.sandbox/config.yaml`, defaulting to "In Review", which matches the usual To Do → In Progress → In Review → Done workflow. On GitHub, the label of that name is added as before.
- dd89baa: The CLI is now published to npmjs.com as `werkmeister` instead of GitHub Packages. Install with `npx werkmeister setup` or `npm install -g werkmeister`, with no registry or token setup. Releases publish through npm trusted publishing from GitHub Actions, so no npm token is stored.
- cc2806e: The GitHub repository is now `jbbz-sandbox/werkmeister` (SW-10). The package's repository URL, the sandbox-tool issue repo in generated issue-filing guides, the plugin marketplace source written by `setup`, the schema `$id`s and the docs all point there. GitHub redirects the old `jbbz-sandbox/sandbox` URLs, so existing clones and links keep working.

## 0.13.0

## 0.12.0

### Minor Changes

- aba829c: PR callbacks (#236): `sandbox pr open` records the Claude Code session that opened each PR (`session`, plus `host_session` in the desktop app), and that session is told once when the PR merges, ships or closes. Desktop sessions are reached through the app by the sandbox-tools mod, which checks every 10 minutes; terminal sessions are resumed headlessly by the new `sandbox pr watch` (run it from cron). It never merges or closes out.
- d7c8058: Workspaces take an opt-in `auto_stop` (#231): `--auto-stop` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_AUTO_STOP`, `auto_stop: true` in `workspace.yml`, or the create form's checkbox. It writes a managed SessionEnd hook to the workspace's `.claude/settings.json` (hand-added hooks are kept; turning it off removes only sandbox's entry) that runs the new `sandbox stop --if-idle`: when the session ends and no other Claude session is open in the workspace, the workspace's own feature containers stop in the background, keeping the slot and volumes so `sandbox up` resumes fast. It never stops shared infra, prints nothing and always exits 0. `sandbox-context.md` says so in Container Lifecycle while it is on. Workspaces without `auto_stop` behave as before.

### Patch Changes

- c143080: Workspace `docker compose` calls now pass `-p sandbox-<feature>` (#225). Running `sandbox workspace` inside another workspace's container no longer builds the new workspace's images under the caller's `COMPOSE_PROJECT_NAME`, so the caller's containers are no longer recreated or removed and the new containers carry their own project label. Covers the init build, every `compose.ts` lifecycle/logs call, and the VS Code log tail (#198 fixed the same leak for infra only).

## 0.11.0

### Minor Changes

- 2f106fc: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- a36b99f: Workspaces take an optional `model` (#233): `--model <alias|id>` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_MODEL`, `model:` in `workspace.yml`, or the create form's new field. It is written to the workspace's `.claude/settings.json` (a model set there by hand is never overwritten, and clearing `model` removes only the value sandbox wrote), passed as `--model` by `claude-send` and `claude-resume`, and returned by `list-workspaces` / `workspace-status`. Workspaces without a model behave as before.

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

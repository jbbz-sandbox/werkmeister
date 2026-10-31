# sandbox-core

## 0.59.2

### Patch Changes

- c87d8b7: SW-279: a run whose `WERKMEISTER_CONFIG_FILE` is not the default `~/.werkmeister/config.yaml` (a temp-HOME fixture) no longer reloads or starts the shared `w9r-caddy`. Before, `workspace abandon` / `workspace close` on such a fixture loaded the fixture's Caddyfile into the real proxy and took routing down for every workspace. `reloadCaddy` and `startCaddy` now skip with `Caddy reload skipped (WERKMEISTER_CONFIG_FILE is not the default home)`, as they already did under `WERKMEISTER_FIXTURE=1`, so teardown, `feature up` / `down`, `infra proxy-reload` and the MCP tools all leave the shared proxy alone.

## 0.59.1

### Patch Changes

- db3505a: SW-264: the generated `with-temp-home` exports `WERKMEISTER_HOST=http://127.0.0.1:1` unless the caller already set it, so a run under a temp HOME can no longer reach the real daemon on :3002; daemon calls raise `DaemonUnavailable` and take their local fallback. Existing workspaces pick it up with `werkmeister machine migrate`.

## 0.59.0

### Minor Changes

- 6e4707d: SW-268: `werkmeister machine config` (bare or `--show`) now also prints the whole `config.yaml` as YAML with secrets masked: any value under a key named like `token`, `secret`, `password`, `credential`, `api_key`, `private_key`, `access_key` or `auth` (so `jira.api_token`) prints as `<redacted>`, and empty values stay empty. The autonomous run limit that says not to read the real `~/.werkmeister` now points agents at this view.

### Patch Changes

- 0b6e9c3: SW-277: test-only. The wrapper npx-bootstrap test runs the wrapper async with a 120 s limit (macOS's first-exec check of its fresh stubs slows with host load), and `infra-retire-legacy`'s `argvOf` names a missing docker-stub line and prints the whole log instead of throwing a TypeError.
- d7ba2ba: SW-278: `werkmeister pr gate` no longer passes silently with zero tests run when a PR's changed files map to no service (for example, the registry has no `repos:` entry for the worktree). It fails a `tests` row that names the files, unless the PR file sets `skip_tests: { tests: <reason> }`. An empty diff and a docs-only diff (all `no_service_paths`) behave as before. The `cli` validate text now says what a gate fixture needs.

## 0.58.0

### Minor Changes

- 80b6117: SW-249: the generated `.devcontainer/devcontainer.json` passes `CLAUDE_CODE_OAUTH_TOKEN` from the host at every attach (`remoteEnv`, `${localEnv:CLAUDE_CODE_OAUTH_TOKEN}`), so a container started with a `claude setup-token` token set needs no Claude login, and no generated file holds the token. Every workspace's container now mounts one shared `~/.claude` volume, `werkmeister-claude-home`, so you log in once; each container still reaches only its own workspace, because the werkmeister registration lives outside the volume and sends that workspace's token. Close-out never removes the shared volume. The per-workspace `features-claude-home-<workspace>` volumes from 0.54.0 are no longer used; drop them with `docker volume rm`.

## 0.57.0

### Patch Changes

- 1cbdd5d: SW-208: `pr open`, `pr status` and `pr gate` resolve `gh` through `WERKMEISTER_GH_BIN` and `docker` through the new `WERKMEISTER_DOCKER_BIN`, as do `runCapture` and `proc.run`/`runAsync`. A fixture run of the built CLI can therefore fake every gh and docker call. A fake first on PATH is not enough, because `childEnv()` puts `/opt/homebrew/bin` and `/usr/local/bin` ahead of it.
- 11d002e: SW-257: taking down the pre-rename `sandbox-infra` stack no longer gives up when the `docker ps` / `docker volume ls` check for held containers takes over 10 s on a loaded host; the check now waits as long as the teardown does, so `infra start` and `down` still free the old stack's ports and volumes.

## 0.56.0

### Minor Changes

- d8c9205: SW-160: `werkmeister pr watch` is werkmeister's own auto-fix. While a PR is open, each pass wakes the session that opened it, in one message, when a check on the head commit fails (with the first error lines of `gh run view --job <id> --log-failed`), when a review or comment arrives (quoted), or when the PR conflicts with its base (with the base commits that moved). Each event is claimed once in the PR file (`notified_checks`, `notified_review`, `notified_conflict`). A terminal or VS Code session whose transcript changed in the last 5 minutes is held and woken on a later pass, so a headless turn never runs beside a live one. PR rule 5 no longer turns on the desktop app's Auto-fix (`ccd_pr set_monitor`), and `pr open` no longer prints the `<pr-created>` marker.

## 0.55.1

### Patch Changes

- a1a40a1: SW-260: give `refreshKubeconfig`'s local `kubectl` calls 30 s and 15 s instead of 10 s and 5 s, so a loaded host no longer reports a missing kubeconfig.
- 378260d: SW-254: a daemon older than the CLI no longer fails with only `Tool scheduler not found`. When the daemon answers that it has no tool the CLI called, the error says the daemon is older than the CLI and names `werkmeister daemon restart` (code `DAEMON_STALE`). Other daemon errors are unchanged.
- 6cf6e82: SW-259: under `node --test`, the Docker client gets a dead socket unless the test file called `useDockerEngine()` (fixtures.mjs), so a core test can no longer read the host engine's containers by accident, even when `DOCKER_HOST` is set. Outside a test run nothing changes.

## 0.55.0

### Minor Changes

- b64c8ea: SW-186 (breaking): the CLI is grouped by noun — `feature`, `workspace` (`ws`), `pr`, `issue`, `infra`, `machine`, `budget`, `daemon` and `internal` — e.g. `up f` is now `feature up f`, `init-workspace` is `workspace init`, `close-out --abandon` is `workspace abandon <reason>`, and the hook commands are `internal gate|pr-guard|agent-state|session-end`. Every old spelling still runs, with the same arguments, and prints one deprecation line on stderr; they are removed in 0.58.0. `werkmeister --help` lists the groups.

  After upgrading, run `werkmeister machine migrate` (`--check` first to see what it would change): it rewrites each workspace's hooks, permission rules and `with-temp-home`, replaces the stale `SANDBOX_MCP_TOKEN` in `secrets.env`, and points Claude Desktop at `werkmeister internal mcp`. Upgrade the CLI and the Claude Code plugin together, and restart open Claude sessions.

  Also: `feature up <f> --service <name>` starts one service (SW-132); `machine config --check` names `--write` only for problems it fixes (SW-162); new `budget status` and `daemon status|install|uninstall|restart`; gen-docs writes one man page per `noun verb`.

### Patch Changes

- 5816545: SW-236: `werkmeister machine setup` no longer leaves the host daemon (or the pr-watch agent) down when `launchctl bootstrap` races the bootout and fails with 5: it retries up to 5 times, 1 s apart. A re-run now bootstraps an agent whose plist is unchanged but isn't loaded, so "re-run to retry" works.
- 662dcfd: SW-239: under `node --test`, `sandboxRoot()` (and so `monorepoRoot()`) throws unless the test called `pinWerkmeisterRoot()`, so a new core test can no longer depend on the unpinned root. Outside a test run nothing changes.
- 1200605: SW-245: `up` now removes a feature with no local services from the waiting queue when it starts it, so the scheduler no longer leaves it waiting and re-ups it on every grant.
- 3e0b4a0: SW-246: the scheduler writes a feature's `waiting.json` before `queue.json` when it queues it (`admit` waiting, or preempted), so a workspace with no `.werkmeister/` gets the ENOENT error and stays out of the queue instead of showing as waiting in `status` with a session that never learns it is queued.
- 2237edb: SW-247: the PR gate's exercise and acceptance checks fail on a result cell that is not exactly `PASS`, such as `FAIL — reason` or `skipped`, in any table with a `result` column. Before, only a cell reading exactly `FAIL` was caught.

## 0.54.0

### Minor Changes

- eaa500b: SW-138: `init-workspace` writes `.devcontainer/devcontainer.json`, so a Claude Code agent in a dev container drives the host daemon on 3002 with the workspace's token; see users-guide § Running the agent itself in isolation.

## 0.53.0

### Minor Changes

- c22be3d: The host daemon now owns the scheduler (SW-185): slot leases, the waiting queue, and starting waiters.

  - **Through the daemon:** the CLI, the stdio MCP server and the dashboard ask the daemon (`POST /api/tool`, machine token) to allocate, read and release slot leases, admit or queue a feature (including preemption), and read the waiting queue. VS Code reaches it through the CLI and the `status` tool. Agents can't call these ops: they aren't on `/mcp`.
  - **Starting waiters:** after a client's `stop` or `down`, the daemon starts the next waiting feature in the background. The CLI prints `The daemon will start the next waiting feature (N waiting)` and no longer starts the waiter's containers itself. The `pr watch` tick still starts waiters.
  - **Fallback:** with no daemon (or no daemon token, as in CI and tests), a client warns once and schedules in its own process against the same `~/.werkmeister/scheduler/` files and locks. The daemon reads those same files, so existing leases and waiters carry over on upgrade with nothing to migrate.
  - **Fix:** `/api/tool` waits up to 15 minutes for a tool instead of the MCP SDK's 60 s, so a long close-out or grant isn't cut off.

## 0.52.1

### Patch Changes

- 29a1404: SW-224: the generated `with-temp-home` waits before its command while the host's 1-minute load is above `budget.host_load`, using the pr gate's wait (same default, same 30-minute cap, then it runs anyway and says so), through the new internal `werkmeister wait-load`. `WERKMEISTER_NO_WAIT=1` skips it; with no `werkmeister` on PATH the wrapper runs at once.
- a69799c: SW-235: an autonomous workspace's BRIEF.md no longer tells the agent to ask the user about its open questions. `## Open questions` drops the "Ask / Confirm with the user …" sentences that follow each question, and says to decide each one per the run limits and record the choice under `## Recommendations for reviewer`. Interactive briefs are unchanged.

## 0.52.0

### Minor Changes

- e75909c: SW-206: `werkmeister close-out` (shipped and `--abandon`) writes `usage.md` and `usage.json` into the workspace record before the folder is removed, committed and pushed with `closeout.md`. They hold token totals by model, the USD estimate, per-session rows (first and last turn, turns, models), wall-clock time, approximate per-stage timing, and the run's werkmeister version and commit, model, autonomous setting and ticket. `closeout.md` gets a one-line `Usage:` summary. A retry after a failed removal keeps the first snapshot; a workspace with no transcripts still gets one that says so. The `workspace-usage` MCP tool's sessions gain `firstTurn`, `lastTurn`, `turns` and `models`.

### Patch Changes

- d1fc18a: SW-198: `pr open` prints the full gate output (`<repo>: gate passed` and every ✓/✗ row, the same text as `pr gate`) before it pushes, not only when the gate fails.
- a8203cc: SW-219: for a repo whose registry entry has a gate `lint` command, the generated `werkmeister-context.md` How to validate test commands end with `&& <lint>`, so the implement stage that runs them catches a format error before `werkmeister pr open`. Repos without `lint` render unchanged; the PR gate's own lint row is unchanged.

## 0.51.1

### Patch Changes

- 5e12dac: SW-209: `pr gate` and `pr open` wait before each lint, test and release check while the host's 1-minute load is above `budget.host_load` (default twice the CPU count, `0` off), for up to 30 minutes, then run anyway and say so; `--no-wait` skips the wait. A failed check ends with the host load, and the generated `with-temp-home` prints the host load when its command fails, so a timeout under load reads as load.

## 0.51.0

### Patch Changes

- a6b8980: SW-205: workspace records no longer push to a stale repo. `werkmeister setup --check` now fails when `repos_root/sandbox-workspace`'s origin isn't `overrides.workspace_repo` (or the `<gh user>/sandbox-workspace` default), naming both URLs; SSH and HTTPS forms of the same owner/repo match. `werkmeister setup` asks before repointing origin to the configured HTTPS URL, keeps the old URL as a remote named after its owner, then fetches; non-interactive runs change nothing and print the commands. It never fetches a mismatched origin. `werkmeister workspace` refuses to create a record worktree until they match.

## 0.50.2

### Patch Changes

- f9a45e5: SW-183: lock waits no longer block the event loop. `sandboxLock` now awaits a timer between retries instead of `Atomics.wait` and always returns a promise, so two concurrent `up` calls through the HTTP MCP server both finish instead of hanging the server (the Caddyfile lock had no timeout) or failing after 30 s (the slot lock).

## 0.50.1

### Patch Changes

- 18d4490: SW-193: a merged PR that needs no release now reaches `shipped`. When the gate's release check runs and reports nothing to bump (changesets' `NO packages to be bumped`), `werkmeister pr open` writes `release: none` into the PR file, and `werkmeister pr status` ships that PR on merge instead of waiting for a release tag that will never contain it, so close-out is no longer stuck. A PR that needs a release still waits for its tag, and `skip_release` still only skips the gate's check.
- 16e90f7: SW-194: `werkmeister pr gate` and `pr open` fail fast when a PR file's `repo:` is not the code worktree's `git remote get-url origin` (SSH and HTTPS forms, with or without `.git`). The `repo` row names the field and shows both values, where the mismatch used to surface as a `gh pr create` GraphQL error. The Stage 04 contract and PR rules now say to take `repo:` from that command.
- 5d2bdcf: SW-199: `pr open` with PR files that exist but are not approved now lists each file and its status (`pr-app.md is at status: draft; set status: approved to open it.`) instead of telling the person to write a file that is already there. "No matching PR file … Write …" is kept for a workspace with no PR files.

## 0.50.0

### Minor Changes

- 050e6a6: SW-181: a file-backed scheduler. A slot is leased in `~/.werkmeister/scheduler/leases.json` the moment it is allocated, so back-to-back creates get distinct slots, and `up`, the gate and `pr open` never move a leased slot: they fail naming whoever sits on it. `up` admits a feature only when the budget (Docker's memory minus 1G and its CPUs by default, `budget:` in config.yaml to override) has room for its memory reservations and CPU limits; otherwise it waits in a queue, its session is held like a pause, and it starts when another feature stops or on the `pr watch` tick. A person's `up` may stop an autonomous feature to make room (`budget.preempt: false` turns it off). The gate checks its ports are free before starting anything, `status` shows the queue, and generated compose sets `memswap_limit` equal to each memory limit.

## 0.49.0

## 0.48.0

### Minor Changes

- 2209de7: SW-182: idle-stop and the Resume nudge read a session liveness record the agent-state hook writes to `.werkmeister/agent-state.json` (`sessions`, keyed by session id), not Claude Code's session files. The hook now also runs on SessionStart; a workspace picks that up at its next `up`.

## 0.47.4

## 0.47.3

### Patch Changes

- 169783d: `werkmeister connect` replaces a host web server that holds its port but can no longer serve (SW-137). An example is an MCP server left running from a deleted worktree that answers 400 to every request. `start()` and `status()` now check the server over HTTP with a JSON POST, instead of trusting a live PID or an open port. The `web-servers-self` test runs on an ephemeral port and kills anything it spawned, so it can no longer start a detached server on the real port 3002.

## 0.47.2

### Patch Changes

- 6de7585: `werkmeister pr gate` and `pr open` run the PR-file checks (stages, acceptance, approved) first and stop before any test command when one fails (SW-150), so a malformed PR file fails in seconds instead of after every registry test command. The acceptance failure message and `pr-rules.md` now state the accepted format: a result cell that is exactly `PASS` or `FAIL`, evidence in its own column.

## 0.47.1

### Patch Changes

- 74e0654: The generated ICM `01_reproduce` and `01_research` contracts ask each decision that renames, keeps or removes a name, fallback or alias for its definition site and the `git log -S` commit that introduced it, and list "remove" as an option when that commit marks a transition or legacy alias (SW-123).

## 0.47.0

### Minor Changes

- 5556fd4: Workspaces ship a temp-HOME test wrapper (SW-124). `init-workspace` writes `.werkmeister/bin/with-temp-home <cmd…>`, which runs a command with a fresh `mktemp -d` HOME and removes it on exit (keeping corepack's cache, so pnpm isn't re-downloaded). `werkmeister-context.md` states each host test command through it, the allow rules pre-approve the wrapped form, and the ICM test step tells agents, and the subagents they brief, to run every test command through it.

### Patch Changes

- ddf7977: The reload step of generated stage contracts no longer forbids `werkmeister up` outright (SW-135): if the container is not running, the agent runs `werkmeister up` once first, because a never-started container has no `pnpm` and `docker restart` on it loops on "pnpm: not found". `docker restart` is only for reloading a running container. Applies to the feature `03_implement`, bugfix `03_exercise` and refactor `02_implement` contracts of new workspaces.
- 9b2283a: SW-148: `runCapture("gh", …)` resolves the binary through `WERKMEISTER_GH_BIN`, so `withFakeGh` fakes every core `gh` call and a test can no longer reach the real `gh` past `childEnv()`'s PATH. The fake now covers `api user` and `search prs` and fails closed on any other subcommand.

## 0.46.0

### Patch Changes

- 9273365: SW-136: `werkmeister config` with no arguments is now read-only — it prints the resolved config (what `--show` printed) and changes nothing. Writing `config.yaml`, `env.sh`, `~/.zshenv` and the Desktop MCP config takes `--write` (the wizard on a TTY, as the bare form ran before) or a value to set (`--repos-root`, `--workspaces-root`). `--show` still works; the `--check` hints now say `werkmeister config --write`.
- 59b5340: `werkmeister up` leaves a workspace's record branch clean (SW-144). The managed `.gitignore` now ignores compose.yml, compose.gate.yml and the runtime state files (`agent-state.json`, `last-exec`, `starts.json`). `up` adds those rules to an older workspace and untracks a committed compose.yml once. init-workspace seeds `.env` before writing settings, so its allow rules already match what `up` writes.
- d688847: ▶ Start work no longer dead-ends in auto mode (SW-157): when the pane's own `start_session` call is refused, it drafts a message in the hosting session's prompt box asking its model to make the same call with the same arguments, and the person presses Enter to send it. Run titles from `startArgs()` / `werkmeister start-args` are cut at a word with a trailing `…` instead of mid-word.

## 0.45.0

### Minor Changes

- 493cff4: ▶ Start work on the workspaces pane card starts a fresh workspace's run in a Desktop session (SW-153). `werkmeister start-args` and werkmeister-core's `startArgs()` build its title, model, prompt and run limits, the next-wave skill uses them, and an autonomous workspace's BRIEF.md now carries the run limits.

## 0.44.4

### Patch Changes

- 8ba5b70: SW-145: `werkmeister pr open` prints a `<pr-created>URL</pr-created>` line for each PR it opens, so the Claude desktop app counts the session as the opener and `set_monitor` with `auto_fix: true` is allowed. Rule 5 in the generated `pr-rules.md` now says: when `set_monitor` is refused, don't retry; ask the person to turn Auto-fix on from the PR bar, and don't rely on `get_status` to confirm it.

## 0.44.3

### Patch Changes

- 65e4060: SW-118: the PR gate now tests a branch's own container settings. When the branch's `.werkmeister/services.yaml` renders a touched service differently from the workspace `compose.yml` (a new `environment:` entry, `node_modules_volume`, image, …), `pr gate` / `pr open` start that service from a gate-only `compose.gate.yml` rendered from the branch, run its tests there, then recreate it from `compose.yml` (or stop it, if it wasn't running). Before, the tests ran in containers built from the machine registry, so such changes were never tested.

## 0.44.2

### Patch Changes

- ff1cff8: SW-109: when `pr open` (or any lifecycle move) can't read the issue, it retries the read once, and if that fails too the warning now gives the reason (Jira's HTTP status and message, the network error code, the MCP fallback, or `gh`'s error) and the `werkmeister issue update <ref> --status … --comment …` command that makes the move by hand. `werkmeister issue view` prints the same reasons when it can't read an issue.
- 09d62c8: SW-115: the shipped `mcp-client` archetype no longer projects the `werkmeister` MCP server into a workspace's `.mcp.json`. That file is shared by host and container sessions, and the entry's `http://host.docker.internal:3002/mcp` only resolves in a container, so every host session hit `ENOTFOUND` on start. Host sessions get the same server from the `werkmeister` plugin. The next `init-workspace` prunes the entry from existing workspaces. A container agent opts back in with an archetype of its own (`docs/users-guide.md`, edit 3).
- c380936: SW-120: the Open PRs tab searches the org from `overrides.github_org` (default: the workspace repo's owner) instead of the stale `sandbox` owner, and fails with a message naming that setting when no org is known rather than searching all of GitHub.

## 0.44.1

## 0.44.0

## 0.43.0

### Minor Changes

- 3bd6bf5: SW-104 ready work: `werkmeister issue ready [--project <name>] [--json]` lists a project's open work in priority order, from its board's ready column in board rank when it has a board, else the scope's open issues. Issue trackers gain `listReady(board?)`. The `next-wave` skill moves into the werkmeister plugin and reads its tickets from `issue ready` on a machine with projects.
- 75bdd3d: SW-108: a post-mortem comes before close-out. `close-out` (CLI, MCP, pane, VS Code) refuses while the workspace has no `postmortem.md`, unless `--skip-postmortem "<reason>"` (MCP `skip_postmortem`) gives a reason, which goes in `closeout.md`. The new werkmeister `postmortem` skill gathers the run's problems, agrees a change for each with the person, writes `postmortem.md` and turns each change into an SW issue, standards edit or memory entry. The ICM route table, propose and spike checks, `pr-rules.md` (ICM and JIT) and `w9r-pr` send agents there before close-out, and the handoff commits `postmortem.md` to the record branch.

## 0.42.0

### Minor Changes

- ba48455: SW-105: the `/workspaces` pane's cards group their buttons by what they act on, one labelled row each: `session` (⇆ Open beside, which replaces ↗ Continue in Desktop and falls back to opening the session in place when the app won't split it; Continue in Terminal / VS Code; ＋ New session; 📌 Pin), `containers` (Up / Resume, Stop, Pause, Restart, Down, then Logs and Open feature ↗ while they run) and `work` (Refresh PRs, Open issue ↗, Close out, Abandon…). The `⋯` menu is gone. Logs opens a Terminal window following the containers' logs (new `followLogsInTerminal` in werkmeister-core). The dashboard, MCP App and VS Code are unchanged.

## 0.41.0

### Minor Changes

- 810e41b: SW-104: projects. A `projects:` map in `~/.werkmeister/config.yaml` names tracking strategies — a tracker (Jira project key, or GitHub org and optional repos), an optional board, and its own `issue_statuses` — so one machine can work on a Jira-tracked product and a GitHub-tracked one. A workspace records its project as `project:` in `workspace.yml` (`--project` on `workspace` / `init-workspace`; the create form and wizard ask after the issue, defaulting to the project whose scope holds the ref, else `default: true`), and its issue link, status moves and `pr open` / ship updates go to that project's tracker. `config --check` names invalid projects; `connect` checks each project's tracker; `config` and `setup` keep `projects:` when they rewrite the file. A machine with no projects, and a workspace with no `project:`, behave as before.

### Patch Changes

- 2290eeb: SW-107: fragment detection puts a package's `typecheck` script before `test` in its detected test command (for pnpm, `pnpm --filter api run typecheck && pnpm --filter api test`), so a workspace's listed test commands fail on a TypeScript error the way CI does. This repo's own `cli`, `werkmeister-core` and `werkmeister-vscode` test commands now run `typecheck` too.

## 0.40.0

### Minor Changes

- 4fc26a8: SW-103: a workspace can create and track more than one PR per code repo. `werkmeister pr new <worktree> --slug <slug>` cuts a fresh branch from base after that worktree's PR merged and writes a draft `pr-<worktree>-<slug>.md` with a `worktree:` field; gate, open, status, adopt, close-out and the workspaces pane handle every PR file of a worktree. `pr open` refuses a branch name an earlier merged PR of the same worktree used. Existing `pr-<repo>.md` files behave as before.

## 0.39.0

### Minor Changes

- c0d2c42: SW-102: a machine with no Kubernetes cluster can now get a baseline.

  - **A new `baseline_upstream` key.** Set `baseline_upstream: "host:port"` on a service in `services.yaml`. Its `{service}` references and its generated `<SVC>_URL` / `_HOST` / `_PORT` then resolve to that address instead of `k8s-forwards`. Before, they threw an error (or the env vars were left out) when the service had no `k8s_forward_port`. The key wins over `k8s_forward_port`, and a service that declares it gets no forward. `status` reports it as `baseline`, and the fragment schema accepts the key.
  - **Baseline containers in `w9r-infra`.** Add `infra.baseline.<service>.image` to `~/.werkmeister/config.yaml`, pinned as `<image>@sha256:<digest>`; a tag-only image is refused. Optionally add `environment`. `connect` then runs the image in `w9r-infra` as `w9r-baseline-<service>`, reachable at `baseline-<service>` on the shared network. Point the service's `baseline_upstream` at that alias.
  - **Removing a baseline.** Its container keeps running until `down infra`.

  See _Without Kubernetes_ in `docs/topology.md`.

## 0.38.1

## 0.38.0

## 0.37.1

### Patch Changes

- 5b37069: SW-100: Caddy starts on a fresh clone, a git worktree or an npm install. The generated `features.json` was file-bound inside the read-only `proxy/ui` mount, so Docker needed a gitignored `apps/cli/infra/proxy/ui/features.json` to exist as the mountpoint, and only old checkouts with a stale copy had one. It now mounts at `/srv/features.json`, and the Caddyfile's `/__werkmeister/features.json` handle serves it from there. The next `connect` / `up infra` regenerates the Caddyfile and recreates Caddy on the new mount. A leftover `apps/cli/infra/proxy/ui/features.json` in an old checkout is no longer read and can be deleted.

## 0.37.0

### Minor Changes

- fa98c10: SW-95: the shared-infra stack no longer says "sandbox". The compose project is `w9r-infra`, the containers are `w9r-caddy` and `w9r-k8s-forwards`, and Caddy's volumes are `w9r-infra_caddy-data` / `w9r-infra_caddy-config`. The dashboard's Jaeger and RedisInsight links point at `*.w9r-infra.orb.local`. On a machine still running the old `sandbox-infra` stack, the next `connect` / `up infra` takes it down first (its containers hold the names and ports 80/443 the new one needs) and then starts the renamed stack, so the proxy restarts once. `down infra` takes the old stack down too. Its volumes are kept unless you pass `--volumes`. Leftover `sandbox-infra_*` volumes can go with `docker volume rm`. An opted-in RedisInsight starts with empty settings, because its volume moves to the new project. Caddy's data is safe to lose: certs are bind-mounted from `certs_dir`.

## 0.36.2

## 0.36.1

### Patch Changes

- 67637e6: SW-97: `werkmeister migrate` no longer tells the person to run an `infra` subcommand, which doesn't exist. The refusal while shared infra is running now names `werkmeister down infra`, and the success message names `werkmeister connect`. A new test fails the build if any backticked `werkmeister …` command in migrate's messages isn't a registered CLI command.

## 0.36.0

### Minor Changes

- 7fa838e: SW-93: the Docker-side names and default domains no longer say "sandbox". New containers carry `com.werkmeister.*` labels, compose projects and per-feature networks are `werkmeister-<feature>`, features join the `werkmeister-shared` network, the built-in build caches live in `werkmeister-<key>` volumes, and the sandbox repo's setup service is `werkmeister-install`. A workspace brought up before this keeps running under its old `sandbox-<feature>` project and `com.sandbox.local.*` labels: slots, `status`, `stop`, `restart`, `logs`, the VS Code tree and the idle reaper all still find it, and its next `up` takes the old project down (keeping its node_modules volumes) before starting the new one. `down` and `close-out` remove both. Caddy and k8s-forwards join both shared networks, and `cache prune` also reaches a leftover `sandbox-<key>` volume. A fragment still naming its setup `sandbox-install` gets the renamed startup script. The default `local_domain`/`remote_domain` are now `local.werkmeister.io`/`remote.werkmeister.io`; a machine whose `config.yaml` sets them (every `setup` run writes them) keeps its own. The X-Feature cookie, the `connect` tool links and the docs-site's allowed hosts (a new `{{local_domain}}` registry placeholder) follow the configured domain instead of a hard-coded `local.sandbox.com`. SW-11 removes the old-name fallbacks.
- 9dfc1cc: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.

## 0.35.5

## 0.35.4

### Patch Changes

- 8dd972e: SW-90: `close-out` is safe when two runs overlap. `closeOut` takes a per-workspace lock, so a second run says `close-out of '<name>' is already running` right away. A run that finds the folder already gone, at the start or by the `closeout.md` write, says the workspace is already closed out instead of throwing ENOENT. `sandbox close-out` without `--yes` and without a terminal refuses at once ("needs --yes when not run from a terminal"). Before, it read an empty stdin and exited 130 after the prompt with no message. Any no-TTY prompt that runs out of input now says so before it exits.

## 0.35.3

### Patch Changes

- e3c5ec9: The PR gate's on-demand start no longer asks compose for a service id only the branch registry knows: when a branch has renamed a service (e.g. `sandbox-core` → `werkmeister-core`) but the machine registry, and so `compose.yml`, still uses the old id, the gate starts the compose service that owns the same path, tests through it, and notes the drift with a pointer to `werkmeister registry` (SW-87).

## 0.35.2

## 0.35.1

### Patch Changes

- 6d24ff6: The PR gate's on-demand service start no longer aborts a cold workspace with `docker compose failed (exit 130)` (SW-86). The 300 s compose timeout was firing while `up -d --wait <svc>` waited on the setup container's install and build. Compose catches the timeout's SIGTERM and exits 130, which `runAsync` took for an ordinary exit. `runAsync` now reports any kill by its own timer as a timeout. `sandbox up` and the gate's service start get a 20-minute budget, and the timeout message states the real budget. A failed start also names the state the container was left in, e.g. `Failed to start cli (left created)`.

## 0.35.0

### Minor Changes

- 8666887: A spike workspace can now open a PR for a deliverable in a code repo, such as a write-up in `docs/research/` (SW-83). A template with no propose stage keeps its PR files in its last stage's `output/` (`stages/02_findings/output/pr-<repo>.md`), so `werkmeister pr gate`, `pr open`, `pr adopt` and close-out work for a spike the same as for any workspace. Spikes now get `_shared/pr-rules.md`, and the findings stage says when to write a PR file. A spike with no PR file closes out as before. A PR file can set `skip_exercise: <reason>` to skip the gate's exercise check when there is nothing to run. With no PR file, `pr gate` / `pr open` say which file to write, where the format is, and that the person approves it. The PR guard now denies only a real `gh pr create` at the start of a statement; the phrase inside quotes, a heredoc body or a grep pattern no longer trips it.

## 0.34.0

### Minor Changes

- 8c99ce9: Remove the SW-9 plugin-rename compatibility shims (SW-23). The old plugin path plugins/sandbox-tools, the link that let `CLAUDE_CODE_PLUGIN_DIRS` installs keep loading the plugin under its old path, is gone: point the setting at `.../plugins/werkmeister`. Generated permission rules no longer allow or deny the `mcp__plugin_sandbox-tools_sandbox-workspace__` prefix, and existing workspaces drop those rules on their next refresh. `.mcp.json` generation no longer deletes a leftover `sandbox` MCP entry from before the rename: remove it by hand if it is still there. `w9r setup` still retires an old `sandbox-tools@sandbox` install. The dashboard's old sandbox-connect tool was already renamed `connect` in SW-48 (0.21.0), so no new Cowork reinstall is needed; an artifact installed before 0.21 still calls the old name and needs `werkmeister:install-workspace-dashboard` run again.

### Patch Changes

- 157e9e8: Check `{@link}` references in core's comments with TypeDoc in CI, and fix the broken `resolveSandboxBin` link in `claude_cli.ts`.

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.0

### Minor Changes

- 62e969a: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

## 0.29.0

## 0.28.1

### Patch Changes

- cd828e1: SW-66: `createWorkspace` and `initWorkspace` take `build: false` to skip the image build, so the core suite's create test no longer leaves a crash-looping `demo-backend` container and `demo` slot on the real Docker daemon.

## 0.28.0

## 0.27.0

## 0.26.1

## 0.26.0

### Minor Changes

- 443da5d: SW-12: start an intercept from the Workspaces pane when Telepresence is installed but not connected.

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

- d4d5e01: SW-42: shared infra only when a workspace needs it.

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

- 61780d5: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.
- 1ed01fe: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- 138b15e: Create form (SW-51): Work type and Workflow are preselected on every GUI, labels drop the terminal hints ("blank to skip", "Enter for default") and follow docs/ui-spec.md, VS Code's New Workspace runs the wizard from the workspaces root instead of ~, and the terminal wizard requires at least one service or repo.
- e132f03: SW-65: the `check-in` MCP tool reports each workspace's `lifecycle` and `prs` (repo, url, status, `release`), and names the shipped or abandoned workspaces with no Claude turn working as `readyToClose`. Before reporting, it ships merged PRs a release tag now contains, with the same rule and code as `werkmeister pr status` and no `gh` call.

## 0.23.0

### Minor Changes

- f9017c7: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

## 0.22.0

### Minor Changes

- 3f0542a: `stop` and `restart` for a feature, for infra and for Caddy now go through the Docker Engine API instead of `docker compose stop`/`restart`. Containers are handled in `depends_on` order: dependents stop first, and dependencies start first. `restart` no longer re-runs a finished setup container. A failure names the container and the daemon's message. `composeStop`, `composeRestart` and `stopCaddy` are now async (SW-60).

### Patch Changes

- 95598c3: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.

## 0.21.0

### Minor Changes

- eb040c0: `werkmeister pr gate` starts one container for a touched repo that has none running, runs the tests through it, and stops it again, pass or fail. Containers that were already running are left alone. compose.yml now also lists the checked-out repos' other services behind the `on-demand` profile, which a plain `up` skips. `stop` and `down` include that profile. The gate's baseline check covers only api/web services. A workspace no longer needs every service listed to pass the gate (SW-34).
- 5f85354: Agent state tells Done, Needs you and Working apart (SW-46). Every workspace now gets a `werkmeister hooks agent-state` hook on UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd. The hook records `{state, at, question?}` in `.werkmeister/agent-state.json`. `getWorkspaceStatuses()` returns `claude.agent` (`working` · `needs-you` · `done` · `idle`), `claude.at` and `claude.question` in place of `claude.waiting`, and falls back to the transcript tail when a workspace has no state file yet. Existing workspaces pick up the hooks on their next `werkmeister up`. The workspaces pane and the dashboard show `◌ Working`, `● Needs you` and `✓ Done`, so a finished run no longer reads "waiting for you".

## 0.20.0

### Minor Changes

- 002e00f: Every generated workspace container gets a CPU limit (`cpus` 1.0, 2.0 for setup services such as sandbox-install), overridable per service, setup service or `extra_services` entry with `cpus:` in services.yaml. `werkmeister stats` and `werkmeister optimize` show each container's CPU limit (SW-40).

## 0.19.0

### Minor Changes

- 1e7d8a7: `werkmeister setup` offers to schedule `werkmeister pr watch` every 10 minutes (launchd on macOS, crontab elsewhere); `werkmeister pr watch --install` / `--uninstall` add or remove it. Logs go to `~/.werkmeister/pr-watch.log` (SW-14).

## 0.18.0

### Minor Changes

- 6f712a9: `getWorkspaceStatuses()` returns every workspace-card field: ICM `stage`, JIT `phase`, `autonomous`, `autoStop` and `lastActivity`, next to the existing per-service health and `model`. `getWorkspacePRs()` returns `ci` (`pass` · `running` · `fail`) and `failingChecks` per PR from `statusCheckRollup`. New exports `icmStage()` and `ciOf()`; the pane now reads the stage from core (SW-47).

### Patch Changes

- bd22bce: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- 3936ebd: `sandbox pr watch` now resumes terminal sessions that ran `sandbox pr open` from a code worktree or other subfolder. `pr open` records the session's start folder (`session_cwd`, from its transcript), and delivery looks the session up and runs `claude -p --resume` from there. It still never falls back to another session.
- 9420fd0: The built-in compose fallback now names feature containers `<feature>-<svc>`, as the template does, instead of `sandbox-<feature>-<svc>`. Both paths and the PR gate's container lookup share one `containerOf(feature, svc)`, so a workspace generated through the fallback has containers the gate, restart lines and allow rules can find.

## 0.17.1

## 0.17.0

### Minor Changes

- 5ba6593: The workspaces MCP server has a new `check-in` tool: the check-in skill's triage in one call. It returns every workspace's labels, container and Claude state, proposed stage gates, and whether its transcript changed since the last check-in, filtered by `skip` / `focus`, plus the `candidates` that need a courier, and marks the check-in time in `<root>/.check-in-last`. It returns plain JSON, so a check-in no longer renders the workspaces table inline the way `list-workspaces` does.

## 0.16.0

### Minor Changes

- 844ccbf: The workspace's issue now moves by itself as the work does (SW-27, SW-24). `sandbox issue start`, run by the first ICM stage and JIT's `sb-research`, moves it to In Progress. `sandbox pr open` moves it to In Review. `sandbox pr status` moves it back to In Progress when a review asks for changes or a PR closes unmerged, and to Done once the work ships; close-out is the safety net. `close-out --abandon` comments the reason, applies `abandoned` when configured, and on GitHub closes the issue as not planned. Configure the statuses with `overrides.issue_statuses: { in_progress, in_review, merged, done, abandoned }` (null skips a point); `issue_review_status` and `issue_done_status` still work. Moves are forward only, post a comment naming the trigger, and a tracker refusal is a warning that never fails a stage, PR open or close-out. On GitHub, a `status:` label replaces the issue's other `status:` labels.
- 70125e3: Service containers of type `cli`, `library` and `extension` now idle by default (SW-32): `sleep infinity` under `init: true`, `restart: on-failure:3`, and no always-passing healthcheck, so an idle workspace uses almost no CPU or memory and `sandbox stop` returns fast. Their `command:` watchers run with `sandbox up --dev` (or `SANDBOX_DEV=1 docker compose up -d`). A service that depends on one of them waits for `service_started`. `sandbox up` now regenerates a `compose.yml` that predates the current template or registry instead of only warning, so existing workspaces drop their watchers on their next `up`. The generated ICM reload lines say to `docker exec` into idle services rather than restart them.
- 39eb67a: Feature containers no longer keep running after a PR (SW-39).
  - `werkmeister pr open` stops the workspace's feature containers once a pass opens a PR and nothing in it failed. `werkmeister pr status` does the same when it records a PR as merged or shipped. Slot and volumes are kept, so `werkmeister up` resumes.
  - The new `werkmeister stop --idle <minutes> [feature]` stops each feature nothing has used for that many minutes. Use means a busy Claude session in the workspace (or one that became idle less than N minutes ago), a container started in that time, or a gate `docker exec`, which the gate now records in `.werkmeister/last-exec`.
  - Every PR watch pass, from the werkmeister mod's timer or from `werkmeister pr watch`, ends with one reaper pass. Its N comes from `overrides.idle_stop_minutes`: 30 by default, `0` for off.
  - `auto_stop` is now on by default for `autonomous` workspaces, and `auto_stop: false` still turns it off. The create form's unticked box no longer writes `auto_stop: false` into a new workspace.

### Patch Changes

- fef4b99: Docs sweep for the Werkmeister rename (SW-10). The README and `docs/` now call the tool Werkmeister, show `werkmeister` (or `w9r`) in every command, and use `~/.werkmeister` and `<workspace>/.werkmeister/`, with a note that the old `~/.sandbox` and `.sandbox/` are still read. The clone steps no longer `cd sandbox`. No behaviour change. The `sandbox` bin, `SANDBOX_*` variables, container names and a repo's `.sandbox/services.yaml` fragment keep their names.
- 07e7d18: The workspace router row for a merged or released PR now says to run `sandbox pr status`, then ask the person before `sandbox close-out`, instead of reading like permission to close out right away (SW-13). The ICM propose-stage contract and JIT's `sb-pr` skill use the same wording. Existing workspaces get it on their next `sandbox init-workspace`.
- 8b4a73d: `sandbox pr gate` (and `pr open`) now tests a branch with its own `.sandbox/services.yaml` fragment: the gated repo's `test:` commands and path mappings come from the worktree, every other repo and the `services.local.yaml` overlay as `registry sync` builds them. A PR that renames packages and updates its own test filters can pass its gate without a machine-wide override, and the shared `~/.sandbox/services.yaml` is not touched (SW-25).
- 65ff7f9: `werkmeister up` no longer fails when the kube context exists but its cluster is switched off. The k8s port-forwards are skipped with a warning when the API server doesn't answer, so features that need nothing from the cluster come up normally (SW-28).

## 0.15.0

### Minor Changes

- f85e6af: Rename the Claude Code plugin `sandbox-tools` to `werkmeister` and its marketplace `sandbox` to `werkmeister` (install id `werkmeister@werkmeister`). The seven `sandbox-*` skills drop the prefix (`/werkmeister:diagnose`, `:workspace`, `:feature-test`, `:status`, `:caddy-reload`, `:routing-test`, `:starting-prompt`). The plugin's MCP server `sandbox-workspace` is now `workspaces` and runs `w9r dashboard`, so its tools are `mcp__plugin_werkmeister_workspaces__*`. The headless registry server `sandbox` is now `werkmeister`, and its tools drop the prefix (`sandbox-up` is `up`, `sandbox-status` is `status`, `sandbox-workspace` is `workspace`, and so on). The dashboard's `sandbox-connect` tool keeps its name.

  An existing install does not move by itself. Run `w9r setup`: it installs the new plugin, then removes `sandbox-tools@sandbox` and the `sandbox` marketplace (`w9r setup --check` flags the old one). `plugins/sandbox-tools` stays as a link to the new directory for one release, and generated permission rules allow both the old and new tool prefixes for one release. Manual steps, including Claude Desktop, are in `plugins/werkmeister/README.md`.

## 0.14.1

## 0.14.0

### Minor Changes

- 6ff0f46: The Caddy feature selector is now served at `/__werkmeister` (SW-8). `/__sandbox` keeps working as an identical, deprecated alias until SW-11 removes it. The `X-Feature` cookie and header are unchanged.
- 99a2303: `sandbox pr open` no longer moves the issue to a hardcoded "In Development". It moves it to `overrides.issue_review_status` from `~/.sandbox/config.yaml`, defaulting to "In Review", which matches the usual To Do → In Progress → In Review → Done workflow. On GitHub, the label of that name is added as before.
- 7e0a144: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- acf3e20: The GitHub repository is now `jbbz-sandbox/werkmeister` (SW-10). The package's repository URL, the sandbox-tool issue repo in generated issue-filing guides, the plugin marketplace source written by `setup`, the schema `$id`s and the docs all point there. GitHub redirects the old `jbbz-sandbox/sandbox` URLs, so existing clones and links keep working.

## 0.13.0

### Minor Changes

- 0853f96: Narrow the `autonomous` permission rules to the workspace's own feature. `Bash(sandbox|docker|npm|gh:*)` and the whole sandbox-workspace MCP server give way to per-command rules (`sandbox up|restart|logs|test <feature>`, `docker exec|logs|restart <feature>-<svc>`, `npm ci|run|test`, read-only `gh` and MCP tools), and a recorded `permissions.deny` blocks `sandbox proxy-reload|down|remove-workspace`, `docker stop|rm`, `npm publish|link` and global installs, `gh pr merge`, and the cross-workspace MCP tools. Rerunning `init-workspace` or `sandbox up` replaces the old rules.

## 0.12.0

### Minor Changes

- e12539a: PR callbacks (#236): `sandbox pr open` records the Claude Code session that opened each PR (`session`, plus `host_session` in the desktop app), and that session is told once when the PR merges, ships or closes. Desktop sessions are reached through the app by the sandbox-tools mod, which checks every 10 minutes; terminal sessions are resumed headlessly by the new `sandbox pr watch` (run it from cron). It never merges or closes out.

## 0.11.0

### Minor Changes

- 0f2892d: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).

## 0.10.1

### Patch Changes

- db54e57: `sandbox up` no longer exits mid-run with Node's "unsettled top-level await" warning while waiting for restarted k8s port-forwards. The redis/postgres probe now treats a peer that hangs up without replying (Docker's port proxy before the tunnel binds) as down instead of waiting forever, so the wait either sees the forwards return and goes on to start the containers, or fails with `FORWARDS_NEVER_READY` (#207). `sandbox status --k8s` and the dashboard's forwards check share the probe and can no longer hang the same way.

## 0.10.0

### Minor Changes

- 93adb9a: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- ca13ea7: Shared-infra `docker compose` calls now pass `-p sandbox-infra`, so a caller whose env sets `COMPOSE_PROJECT_NAME` (every workspace container) no longer addresses the shared stack as its own project, which used to report k8s-forwards unhealthy and then fail restarting it. `sandbox up`/`down`/`stop`/`restart` run inside the target feature's own container now refuse with `INSIDE_OWN_CONTAINER` instead of killing themselves with exit 137 (#198).
- 5247bbc: An aborted stats collection now cancels the container stats requests in flight instead of waiting out a host-wide snapshot, so it stops right away however many containers are running, and the `stats-collect` aborted-run test no longer times out on a loaded host (#182).

## 0.9.1

### Patch Changes

- 4d0219c: `sandbox close-out` and `sandbox remove-workspace` now remove the workspace's per-feature Docker volumes (`docker compose down --volumes`) when they delete it, instead of leaving `<feature>-node-modules` and `<feature>-tools` behind. Plain `sandbox down` still keeps them.

## 0.9.0

### Minor Changes

- 5d23026: `sandbox pr gate`: a repo's registry `repo:` block can list `no_service_paths` (e.g. `docs`, `.changeset`, `README.md`); changes under them touch no service, so a docs-only PR no longer needs `skip_tests` for every service. The sandbox repo declares `docs`, `.changeset`, `.gitignore` and `README.md`.

### Patch Changes

- bc09b75: An ICM workspace's tracked `_shared/standards.md` no longer holds machine paths: each row reads `<standards_dir>/<module>/STANDARD.md`, with a line saying `sandbox standards check` prints that root and `sandbox setup` grants Claude Code read access to it. Opening the record on a machine with a different home dir or `overrides.standards_dir` no longer makes `sandbox skills check` report the file as drifted. Existing workspaces get the portable form on their next `sandbox skills sync` (#163).
- 100e350: `sandbox up` now regenerates `<workspace>/.sandbox/supergraph-config.yml` on every run, not only when the slot changes, so a stale copy is removed when the registry has no GraphQL subgraph (#120).

## 0.8.0

### Patch Changes

- 88430c7: `sandbox init-workspace` no longer adds the current template's stage dirs beside an older ICM layout. In a workspace whose `stages/` holds dirs the current template does not render (e.g. `03_verify`/`04_ship` from before the rename to `03_exercise`/`04_propose`), init now warns and leaves `CLAUDE.md`, `CONTEXT.md`, `_shared/` and `stages/` as they are, and `skills check`/`sync` leave them alone too. Services are still reconciled into `docker-compose.yml`, `.env` and `.sandbox/sandbox-context.md`. To regenerate the pipeline from the current template, move `stages/` aside and rerun (#149).
- e40578c: `generateSupergraphConfig` no longer creates an empty `<workspace>/.sandbox/` when the registry has no GraphQL service and there is nothing to write (#119).

## 0.7.0

### Patch Changes

- 5f1c77f: `sandbox pr open` no longer fails to move a GitHub issue to "In Development" when the repo has no such label. The GitHub tracker now runs `gh label create <status> --color 1D76DB --force` before adding a status label, so the label is created when missing and left as is (same color) when present (#156).

## 0.6.0

### Patch Changes

- 4485440: `SANDBOX_FEATURE` is no longer read as the `feature` input. Every workspace container exports it as its own feature name, so a workspace created or inited from inside one was prefilled with that name. Pass `--feature` or set `feature:` in `workspace.yml` instead. The `sandbox-install` setup service now runs `npm ci`, so `sandbox up` no longer rewrites `package-lock.json`, and the compose-logs smoke test targets its own workspace's stack (#148).

## 0.5.1

### Patch Changes

- 0bb624c: `discoverRepos` and `repoDirs` now share one rule for which workspace dirs are repos: dot-prefixed dirs are skipped and symlinked dirs count. Before, an icm workspace with a dot-prefixed or symlinked repo dir reported drift in `sandbox skills check` that `sync` could never clear (#110).

## 0.5.0

## 0.4.0

### Minor Changes

- `sandbox setup` asks for the issue tracker (`overrides.issue_tracker`: `jira` or `github`). With `github`, issues are per repo and the tracker spans every repo in the services registry under `github_org`: `sandbox workspace` asks for a GitHub issue (`repo#n`, `owner/repo#n` or an issue URL; `--github-issue`) instead of a Jira ID, `CLAUDE.md` links it, and the issues guide sends app-code issues to those repos' issues. With `jira`, the issues guide sends them to the workspace ticket's Jira project. Jira links now use `jira.base_url` instead of a hardcoded site.
- The `sandbox workspace` terminal wizard now renders from the same RJSF form schema as the browser form and MCP UI, so every surface shows the same fields, choices and validation. Local-service choices are listed under the repo that owns them in both the wizard and the create form. Removed `--print-prompts` and `--print-form-schema` from `workspace` and `init-workspace`; the form schema is built in-process by `getFormSchema`.
- Generated workspaces include an issue-filing guide — `_shared/issues-report.md` for icm, `.sandbox/issues-report.md` for jit — routed from `CLAUDE.md`. Every issue has a type (bug | feature | task) that sets its GitHub label (`bug`, `enhancement`, `task`) or Jira issue type (Bug, Story, Task) and its body template. Bugs this workspace's changes caused are fixed in place; bugs that were already there, and features or tasks outside the workspace's task, are filed on `jbbz-sandbox/sandbox` or where the app code's issues live.

### Patch Changes

- `init-workspace` no longer treats plain directories (ICM `_shared/`, `stages/`) as repo worktrees when the workspace root is itself a git repo. Before this, it refused with "Refusing to remove worktree(s) with uncommitted changes" or tried to remove them, and it gitignored them. A directory now counts as a repo only if it has its own `.git`. Rerun `sandbox init-workspace` to clean the stale `/_shared/` and `/stages/` lines out of the managed `.gitignore` section.

## 0.3.0

## 0.2.0

## 0.1.3

### Patch Changes

- `.sandbox/workspace.yml` gains a `context_strategy` field (`jit` or `icm`, defaulting to `jit`) that selects which context layer `init-workspace` generates and `up` refreshes. `sandbox workspace` and `sandbox init-workspace` gain a matching `--context-strategy` flag (env: `SANDBOX_CONTEXT_STRATEGY`).
- `sandbox skills`, `sandbox notes context` and `sandbox hooks gate` now dispatch through the workspace's `context_strategy` instead of assuming jit. `skills check`'s success line reads `Context layer fresh (<id>).`, and the "lags" hint now fires whenever the strategy's `check()` reports anything (previously only on drift). The MCP `sandbox-skills` tool returns `{ drift: string[] }` for `check` and `{ wrote: string[] }` for `sync`; `sandbox-hooks` now refreshes the workspace's context layer (jit: re-merge hooks; icm: remove sandbox-managed hooks) and returns `{ strategy: string }` instead of a hook file path. `sandbox-workspace`/`sandbox-init-workspace` gain a matching `context_strategy` argument.

## 0.1.2

## 0.1.1

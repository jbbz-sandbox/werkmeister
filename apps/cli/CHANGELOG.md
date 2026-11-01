# @jbbz-sandbox/sandbox-cli

## 0.62.0

### Minor Changes

- 506e04b: SW-309: agents ask a person through Markdown forms. Each question in a form is a `## ` heading with `status: proposed`. Options are `- ( )` (pick one) or `- [ ]` (pick any), with `(recommended)`, `Other:`, and an empty `**Label:**` text box. `decisions.md` uses this syntax, every later ICM stage except propose ends by writing `output/question-approval.md`, and a question that comes up partway through a stage goes in `output/question-<slug>.md`, after which the agent stops. On the /workspaces pane, a workspace card with an open form shows `❓ <file> · N open`. Its Answer button opens the form inside the card as one sheet with one Submit. Submit writes the ticks and text back, changing only those lines and the `status:` line, refuses when the file changed after it was drawn, and asks the root session to relay "gate decided, continue". New in werkmeister-core: `parseForm`, `applyAnswers`, `formErrors`, `submitForm` and `openForms`. A `question-*.md` file never counts as a stage's output.

## 0.61.0

### Minor Changes

- 7207f93: The host daemon now knows which build it loaded (SW-306). `werkmeister daemon status` shows it, or `stale (loaded <x>, on disk <y>)` after a rebuild or upgrade; the CLI warns once per run when it reaches a daemon on another build; and under launchd the daemon restarts itself on the new build once no call or queued feature is in flight.

### Patch Changes

- d2f4b65: An autonomous workspace's `BRIEF.md` now has exactly one `## Run limits` section: a copy that the `starting_prompt` or description brings along is dropped, so only the canonical limits (`werkmeister feature up`/`feature stop`, `werkmeister infra proxy-reload`) remain and the brief no longer contradicts itself (SW-308).
- 135cd3a: `pr gate` / `pr open`: a failed lint, test or release row now names the failing tests (`not ok`, `✖`, `×`, `FAIL` lines from anywhere in its output) above its tail, and saves the whole output to `.werkmeister/gate-<repo dir>-<row>.log` in the workspace root, printing that path (SW-317).
- c0b4184: SW-304: the generated human checks, the ICM one rule, `pr-rules.md` and the `w9r-pr` skill now say a direct chat reply from the person ("decided", "approved", "proceed") counts as the approval: the agent flips the status itself and notes it, e.g. `(approved in chat YYYY-MM-DD)`. An approval relayed by another session counts only when it arrives through check-in.
- 1843168: SW-313: a `pr watch` wake can now fix the PR in a workspace without `autonomous`. The headless turn gets the workspace's autonomous allow and deny rules, and the pass waits for it. Refused calls that left the fix behind (uncommitted edits or unpushed commits) show as `auto-fix blocked: needs approval — …` in the log and as `needs-you` on the workspace card; refusals the agent got around are one `refused and retried` log line. A wake for a session that is still open, idle included, is held (with `needs-you`, `waiting for your open session: …`) instead of forking that session's history.

## 0.60.2

### Patch Changes

- a9d211b: SW-187: Claude Code-specific code now sits behind a harness interface (`harness()` returning a `HarnessAdapter`), with the Claude adapter under `harness/claude/` in core, the MCP server, the CLI and the VS Code extension. That covers the `claude` CLI calls, `CLAUDE.md` and hooks generation, the transcript reader, usage and pricing, session driving, the 4 `claude-*` MCP tools, `detect --assist`'s Agent SDK resolver, the `claude --continue` terminals, `wrap_up` and PR rule 5's Desktop sentence. No behaviour change: generated workspace files and the MCP tool list are identical, and every old export from `werkmeister-core` still resolves.
- 59a55f9: SW-294: the `docker context inspect` fallback that picks the Docker endpoint now waits 30 s instead of 10 s, so a load-starved CLI no longer sends werkmeister to the default socket (a different daemon on OrbStack or Colima).

## 0.60.1

### Patch Changes

- 9238da2: SW-270: `werkmeister workspace close --no-pr "<reason>"` (MCP `close-out` `no_pr`) closes a workspace whose work changed no repo as done, not abandoned. It needs no PR files, `postmortem.md`, and every code worktree clean with no commits ahead of its base, and refuses with the failing repo named otherwise. The issue moves to Done with `No PR needed: <reason>`, which goes in `closeout.md` too. A no-PR workspace closed without the flag now hears about `--no-pr` beside `workspace abandon`.
- 35c2dd8: SW-286: `pr gate` / `pr open` check `exercise.md` with the PR-file checks, so a malformed exercise table (`PASS: …`, `(reproduces bug)`) fails before any test command runs instead of after them. The generated ICM contracts that write `exercise.md` (03_implement, the bug-fix/incident 03_exercise, the refactor implement stage) now say the result cell is exactly `PASS` or `FAIL` with output in its own column (`| check | result | evidence |`, or `detail` for 03_exercise), that this holds for every table in the file, and that a superseded run goes in prose, not a `FAIL` row. 04_propose says the same for every result-column table in the PR body, and the JIT `w9r-test` skill matches.
- 316d1d6: `werkmeister issue start` prints a `CLI:` line saying whether the installed werkmeister is current (the latest release, or a link on `main` containing `origin/main`) and the fix when it is stale; 01_research step 0 tells the agent to stop on a stale CLI.

## 0.60.0

### Minor Changes

- 429226a: SW-271: `werkmeister issue start`, step 0 of the first ICM stage and of JIT's `w9r-research`, now also brings each code worktree up to its base. It fetches origin, and a branch with no commits of its own is fast-forwarded to `origin/<base>`. A branch with its own commits, uncommitted changes, or a fetch that fails is left as is, with a `Worktree:` line such as `app: 4 commits behind origin/main (has its own commits, left as is)`. It still exits 0, so a stage never fails on it. A wave workspace created days before its run no longer starts research on stale code.

### Patch Changes

- c73f9ee: SW-262: the PR gate's host-load wait is one 10 min budget for the whole run, shared by lint, each test and the release check, instead of up to 30 min before each one. Before it waits, `pr gate` / `pr open` says how long it may wait (`waiting up to 10 min for host load …`) and prints a `still waiting …` line each minute; once the budget is spent the remaining checks run at once and their rows say so. `werkmeister internal wait-load` (run by `with-temp-home`) waits up to 10 min the same way. `_shared/pr-rules.md` rule 3 and the 04_propose contract now say to run `pr open` detached with `nohup … ; echo "exit $?" >> .werkmeister/pr-open.log` and read the log to the `exit` line (SW-266, SW-273, SW-298).
- df3b424: SW-285: `with-temp-home` keeps `DOCKER_CONFIG` at the caller's `~/.docker`, so `docker compose` works under a temp HOME; the workspace lookup compares real paths, so a `/var/…` workspaces root matches a `/private/var/…` cwd on macOS; and the cli validate text gives the exact `pwd -P`, `init --feature`, `feature up|stop|down <name>` sequence.
- 5381f39: The `list-workspaces` widget falls back to the list it opened with when the host refuses its own server calls (the Desktop Code tab answers them with "IPC not available"), instead of showing "Couldn't reach the host".

## 0.59.4

## 0.59.3

### Patch Changes

- c6107f6: A workspace's `starting_prompt` (distilled from the ticket) and its autonomous `BRIEF.md` no longer list machine-writing steps (`werkmeister registry sync`, `werkmeister infra proxy-reload`, `npm link`, global installs) as run steps; they move to an `## After merge` note, so the brief no longer contradicts its run limits (SW-296).

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

- 8d6063f: SW-230: a `services.yaml` service can be image-only: `image:` with no `repo:`, plus an optional `internal_port`/`port_offset` and `command`. `workspace init` accepts it (a service with neither a repo nor an image is still an unknown service), and the compose template renders it like an app service, with no repo mount, `working_dir` or build, and the image's own CMD unless `command` is set. A fixture workspace can now run a real `up` → `stop` → `down` on e.g. `nginx:alpine`. Declare it in the machine `services.yaml` or its overrides, not in a repo fragment.
- 80b6117: SW-249: the generated `.devcontainer/devcontainer.json` passes `CLAUDE_CODE_OAUTH_TOKEN` from the host at every attach (`remoteEnv`, `${localEnv:CLAUDE_CODE_OAUTH_TOKEN}`), so a container started with a `claude setup-token` token set needs no Claude login, and no generated file holds the token. Every workspace's container now mounts one shared `~/.claude` volume, `werkmeister-claude-home`, so you log in once; each container still reaches only its own workspace, because the werkmeister registration lives outside the volume and sends that workspace's token. Close-out never removes the shared volume. The per-workspace `features-claude-home-<workspace>` volumes from 0.54.0 are no longer used; drop them with `docker volume rm`.

## 0.57.0

### Minor Changes

- 9a5366e: SW-216: `werkmeister workspace init --no-build` (old spelling `init-workspace`) writes compose.yml and the context files but skips the `docker compose up --build --no-start` image build, so a built-CLI exercise against a fixture makes no docker call. The default is unchanged. The `cli` and `werkmeister-core` validate text names the flag.

## 0.56.0

### Minor Changes

- d8c9205: SW-160: `werkmeister pr watch` is werkmeister's own auto-fix. While a PR is open, each pass wakes the session that opened it, in one message, when a check on the head commit fails (with the first error lines of `gh run view --job <id> --log-failed`), when a review or comment arrives (quoted), or when the PR conflicts with its base (with the base commits that moved). Each event is claimed once in the PR file (`notified_checks`, `notified_review`, `notified_conflict`). A terminal or VS Code session whose transcript changed in the last 5 minutes is held and woken on a later pass, so a headless turn never runs beside a live one. PR rule 5 no longer turns on the desktop app's Auto-fix (`ccd_pr set_monitor`), and `pr open` no longer prints the `<pr-created>` marker.

## 0.55.1

### Patch Changes

- ed3210a: SW-222: a workspace with no services now gets `services: {}` in its compose.yml instead of a bare `services:` (YAML null), so `docker compose` no longer rejects it with "services must be a mapping".

## 0.55.0

### Minor Changes

- b64c8ea: SW-186 (breaking): the CLI is grouped by noun — `feature`, `workspace` (`ws`), `pr`, `issue`, `infra`, `machine`, `budget`, `daemon` and `internal` — e.g. `up f` is now `feature up f`, `init-workspace` is `workspace init`, `close-out --abandon` is `workspace abandon <reason>`, and the hook commands are `internal gate|pr-guard|agent-state|session-end`. Every old spelling still runs, with the same arguments, and prints one deprecation line on stderr; they are removed in 0.58.0. `werkmeister --help` lists the groups.

  After upgrading, run `werkmeister machine migrate` (`--check` first to see what it would change): it rewrites each workspace's hooks, permission rules and `with-temp-home`, replaces the stale `SANDBOX_MCP_TOKEN` in `secrets.env`, and points Claude Desktop at `werkmeister internal mcp`. Upgrade the CLI and the Claude Code plugin together, and restart open Claude sessions.

  Also: `feature up <f> --service <name>` starts one service (SW-132); `machine config --check` names `--write` only for problems it fixes (SW-162); new `budget status` and `daemon status|install|uninstall|restart`; gen-docs writes one man page per `noun verb`.

### Patch Changes

- e302406: MCP: `resources` and `intercepts` declare an outputSchema, so clients validate what the VS Code extension polls, and every tool now declares `readOnlyHint` (SW-241).

## 0.54.0

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
- 8551954: SW-229: `list-workspaces` results no longer fail an MCP client's output-schema check (its schema was missing `model`). Every MCP tool with an `outputSchema` now declares `readOnlyHint`, and a test validates each read-only tool's result against its schema the way a client does after `tools/list`.
- a69799c: SW-235: an autonomous workspace's BRIEF.md no longer tells the agent to ask the user about its open questions. `## Open questions` drops the "Ask / Confirm with the user …" sentences that follow each question, and says to decide each one per the run limits and record the choice under `## Recommendations for reviewer`. Interactive briefs are unchanged.

## 0.52.0

### Minor Changes

- 08536f2: The HTTP MCP server on port 3002 is now the host daemon (SW-184). Each workspace gets its own token, so a dev-container agent can drive that workspace's lifecycle (and only that workspace's) through the daemon. The VS Code extension and the SessionEnd auto-stop go through the daemon too.

  - **Per-workspace tokens:** `init-workspace` writes `~/.werkmeister/tokens/<workspace>`, with a copy in the git-ignored `.werkmeister/token`. On `/mcp` the token lists only that workspace's verbs and refuses any other workspace (code `SCOPE`). `close-out` deletes it.
  - **New endpoints:** `POST /api/tool` (machine token) for host thin clients, and `GET /api/logs/stream` (SSE) for following logs.
  - **New tools:** `clean`, `stats`, `optimize`, `cache`, `registry`, `resources` and `intercepts`.
  - **VS Code:** the extension's status (5 s), resources (30 s), intercepts, close-out and log follow now go through the daemon. It shows "werkmeister daemon not running" when the daemon is down.
  - **SessionEnd auto-stop:** `stop --if-idle` hands the stop to the daemon, and falls back to a local stop when the daemon is down. The hook fast paths (`hooks gate`, `pr-guard`, `agent-state`) are unchanged.
  - **Test switch:** `WERKMEISTER_FIXTURE=1` keeps a run off Caddy, k8s forwards, telepresence, `/etc/hosts` and the real `gh`.
  - **Fix:** the `status` tool's output schema accepts every workspace field, so an MCP client that lists tools first no longer rejects its result.
  - **Port setting:** `overrides.mcp_port` / `WERKMEISTER_MCP_PORT` now sets the daemon's port.

  **Breaking, on upgrade:**

  1. On macOS, run `werkmeister setup` and accept "Install the launchd agent?". It installs `com.werkmeister.daemon`, which keeps the daemon up, and replaces the 3002 process `connect` started. Elsewhere, keep using `werkmeister connect`.
  2. Re-run `werkmeister init-workspace` in every open workspace. It writes the workspace token and regenerates `.mcp.json`. The pre-SW-106 `x-sandbox-feature` header is no longer read.
  3. Container agents set `WERKMEISTER_MCP_TOKEN` from the workspace's `.werkmeister/token`, not `~/.werkmeister/mcp-token`.
  4. Reload VS Code windows so the extension picks up the change.

  **Rollback:** reinstall the previous version and run `launchctl bootout gui/$(id -u)/com.werkmeister.daemon`. Older versions ignore the token files.

- e75909c: SW-206: `werkmeister close-out` (shipped and `--abandon`) writes `usage.md` and `usage.json` into the workspace record before the folder is removed, committed and pushed with `closeout.md`. They hold token totals by model, the USD estimate, per-session rows (first and last turn, turns, models), wall-clock time, approximate per-stage timing, and the run's werkmeister version and commit, model, autonomous setting and ticket. `closeout.md` gets a one-line `Usage:` summary. A retry after a failed removal keeps the first snapshot; a workspace with no transcripts still gets one that says so. The `workspace-usage` MCP tool's sessions gain `firstTurn`, `lastTurn`, `turns` and `models`.

### Patch Changes

- d1fc18a: SW-198: `pr open` prints the full gate output (`<repo>: gate passed` and every ✓/✗ row, the same text as `pr gate`) before it pushes, not only when the gate fails.
- a8203cc: SW-219: for a repo whose registry entry has a gate `lint` command, the generated `werkmeister-context.md` How to validate test commands end with `&& <lint>`, so the implement stage that runs them catches a format error before `werkmeister pr open`. Repos without `lint` render unchanged; the PR gate's own lint row is unchanged.

## 0.51.1

### Patch Changes

- 5e12dac: SW-209: `pr gate` and `pr open` wait before each lint, test and release check while the host's 1-minute load is above `budget.host_load` (default twice the CPU count, `0` off), for up to 30 minutes, then run anyway and say so; `--no-wait` skips the wait. A failed check ends with the host load, and the generated `with-temp-home` prints the host load when its command fails, so a timeout under load reads as load.

## 0.51.0

### Minor Changes

- 2d1822c: `werkmeister --version` (and `-V`) prints the CLI version.

### Patch Changes

- a6b8980: SW-205: workspace records no longer push to a stale repo. `werkmeister setup --check` now fails when `repos_root/sandbox-workspace`'s origin isn't `overrides.workspace_repo` (or the `<gh user>/sandbox-workspace` default), naming both URLs; SSH and HTTPS forms of the same owner/repo match. `werkmeister setup` asks before repointing origin to the configured HTTPS URL, keeps the old URL as a remote named after its owner, then fetches; non-interactive runs change nothing and print the commands. It never fetches a mismatched origin. `werkmeister workspace` refuses to create a record worktree until they match.
- f553851: A workspace description containing `'`, `"`, `$`, `#` or `\` no longer breaks docker compose: `init-workspace` writes such values to `.env` in double quotes, and re-runs read them back unchanged (SW-207).

## 0.50.2

### Patch Changes

- f9a45e5: SW-183: lock waits no longer block the event loop. `sandboxLock` now awaits a timer between retries instead of `Atomics.wait` and always returns a promise, so two concurrent `up` calls through the HTTP MCP server both finish instead of hanging the server (the Caddyfile lock had no timeout) or failing after 30 s (the slot lock).

## 0.50.1

### Patch Changes

- 18d4490: SW-193: a merged PR that needs no release now reaches `shipped`. When the gate's release check runs and reports nothing to bump (changesets' `NO packages to be bumped`), `werkmeister pr open` writes `release: none` into the PR file, and `werkmeister pr status` ships that PR on merge instead of waiting for a release tag that will never contain it, so close-out is no longer stuck. A PR that needs a release still waits for its tag, and `skip_release` still only skips the gate's check.
- 16e90f7: SW-194: `werkmeister pr gate` and `pr open` fail fast when a PR file's `repo:` is not the code worktree's `git remote get-url origin` (SSH and HTTPS forms, with or without `.git`). The `repo` row names the field and shows both values, where the mismatch used to surface as a `gh pr create` GraphQL error. The Stage 04 contract and PR rules now say to take `repo:` from that command.
- 3c5fda4: SW-196: `init-workspace` and `workspace` regenerate `~/.werkmeister/services.yaml` from the repo fragments first, so a fragment change merged to main reaches the next workspace's werkmeister-context.md without a manual `werkmeister registry sync`. A hand-written registry is left as is, with a warning.
- 5d2bdcf: SW-199: `pr open` with PR files that exist but are not approved now lists each file and its status (`pr-app.md is at status: draft; set status: approved to open it.`) instead of telling the person to write a file that is already there. "No matching PR file … Write …" is kept for a workspace with no PR files.

## 0.50.0

### Minor Changes

- 050e6a6: SW-181: a file-backed scheduler. A slot is leased in `~/.werkmeister/scheduler/leases.json` the moment it is allocated, so back-to-back creates get distinct slots, and `up`, the gate and `pr open` never move a leased slot: they fail naming whoever sits on it. `up` admits a feature only when the budget (Docker's memory minus 1G and its CPUs by default, `budget:` in config.yaml to override) has room for its memory reservations and CPU limits; otherwise it waits in a queue, its session is held like a pause, and it starts when another feature stops or on the `pr watch` tick. A person's `up` may stop an autonomous feature to make room (`budget.preempt: false` turns it off). The gate checks its ports are free before starting anything, `status` shows the queue, and generated compose sets `memswap_limit` equal to each memory limit.

## 0.49.0

### Minor Changes

- 4634103: SW-180: `werkmeister --help` groups its commands (Everyday first, Internal last), and each command's `--help` ends with its long help from `apps/cli/src/commands/<command>.help.md`. The same files generate the users guide's command reference and new man pages (`man werkmeister`, `man werkmeister-up`), which a global install links. Commander is now 14.

## 0.48.0

### Minor Changes

- e73d2b1: `werkmeister pr gate` runs a repo's lint/format command, set by `lint:` in its fragment's `repo:` block, as a `lint` row; a failure blocks `pr open` (SW-133).

## 0.47.4

### Patch Changes

- 5eca196: SW-143: every ICM exercise step (feature and refactor `implement`, bugfix/incident `exercise`) now says what to do when the change has no service to restart: build it, then exercise the built artifact as its Validation text in `werkmeister-context.md` says. The templates stay app-agnostic; how to exercise a given library or CLI comes from its service's (or archetype's) `validate:`. The werkmeister repo's own `cli` and `werkmeister-core` services now carry the full recipe there: run the built binary from a temp folder against a fixture workspace with seeded config and `WERKMEISTER_CONFIG_FILE`, write-capable commands only against the fixture, read-only ones (e.g. `werkmeister skills check`) from the real workspace. Existing workspaces pick it up after `werkmeister registry sync` and the next `werkmeister init-workspace`.

## 0.47.3

## 0.47.2

### Patch Changes

- af8f975: `pnpm turbo run build --filter=werkmeister` rebuilds `dist/mcp.js` after a commit that changes only `apps/werkmeister-mcp` (SW-131). `apps/cli` now declares `werkmeister-mcp` as a workspace dependency, so turbo's hash for `werkmeister#build` covers the sources esbuild bundles into `mcp.js` and the rebuild command in the stale-build warning clears the warning instead of replaying a stale cache. A test keeps `BUNDLE_SOURCES` and the declared dependencies in step.

## 0.47.1

## 0.47.0

### Patch Changes

- 46e350c: A new workspace's record branch and code worktree branches track their own `origin/<user>/<workspace>` instead of `origin/main` (SW-146), so the first plain `git push` creates the remote branch instead of failing on a push.default mismatch. Existing workspaces are not migrated; `git push -u origin HEAD` still fixes one.

## 0.46.0

### Minor Changes

- 9273365: SW-136: `werkmeister config` with no arguments is now read-only — it prints the resolved config (what `--show` printed) and changes nothing. Writing `config.yaml`, `env.sh`, `~/.zshenv` and the Desktop MCP config takes `--write` (the wizard on a TTY, as the bare form ran before) or a value to set (`--repos-root`, `--workspaces-root`). `--show` still works; the `--check` hints now say `werkmeister config --write`.

## 0.45.0

## 0.44.4

### Patch Changes

- 8ba5b70: SW-145: `werkmeister pr open` prints a `<pr-created>URL</pr-created>` line for each PR it opens, so the Claude desktop app counts the session as the opener and `set_monitor` with `auto_fix: true` is allowed. Rule 5 in the generated `pr-rules.md` now says: when `set_monitor` is refused, don't retry; ask the person to turn Auto-fix on from the PR bar, and don't rely on `get_status` to confirm it.

## 0.44.3

### Patch Changes

- 65e4060: SW-118: the PR gate now tests a branch's own container settings. When the branch's `.werkmeister/services.yaml` renders a touched service differently from the workspace `compose.yml` (a new `environment:` entry, `node_modules_volume`, image, …), `pr gate` / `pr open` start that service from a gate-only `compose.gate.yml` rendered from the branch, run its tests there, then recreate it from `compose.yml` (or stop it, if it wasn't running). Before, the tests ran in containers built from the machine registry, so such changes were never tested.

## 0.44.2

### Patch Changes

- ff1cff8: SW-109: when `pr open` (or any lifecycle move) can't read the issue, it retries the read once, and if that fails too the warning now gives the reason (Jira's HTTP status and message, the network error code, the MCP fallback, or `gh`'s error) and the `werkmeister issue update <ref> --status … --comment …` command that makes the move by hand. `werkmeister issue view` prints the same reasons when it can't read an issue.
- 5dde4d0: SW-112: `werkmeister pr new` refusing over an open or approved PR file now adds "If it has merged, run werkmeister pr status first to record it.", since the file may only be stale.
- 9961fe6: SW-113: `werkmeister issue`, `notes`, `skills` and `hooks gate` find their workspace by the same rule as `init-workspace`: the folder directly under `paths.workspaces_root` (or `~/workspace`) that holds the current folder. A run with a temp config no longer resolves a real workspace from its current folder, and a command run inside a code worktree resolves the workspace instead of stopping at the worktree's own `.werkmeister/`. Migration: a workspace kept outside those roots is no longer found by these commands; move it under `workspaces_root`, or point `workspaces_root` at its parent with `werkmeister config`. The 03_implement contract's exercise step now says to run a CLI from a temp folder, not only with a temp HOME.

## 0.44.1

### Patch Changes

- 180e74f: SW-117: the `postmortem` skill (step 5) and `docs/workspace-lifecycle.md` § Post-mortem rank the actions for a lesson: a shipped change through an SW issue first, a standards edit second, and a memory entry only for one person's own preferences, since that memory is per-machine and never ships with werkmeister. "Already enforced by `<check>`" is now an allowed action.

## 0.44.0

### Minor Changes

- fd482b8: `werkmeister registry sync` skips repos listed in `disabled_fragments` in `~/.werkmeister/services.local.yaml`, leaving their services, setup_services and infrastructure out of the registry, and reports each skip. (SW-129)

### Patch Changes

- a57e706: SW-128: the stale-build warning no longer fires when HEAD moved only outside the CLI bundle's sources (`apps/cli`, `apps/werkmeister-mcp`, `packages/werkmeister-core`, `pnpm-lock.yaml`). turbo replays a cached `dist` for such a commit, still stamped with the older SHA, so the warning appeared after every docs-only pull and the rebuild it named could not clear it. The PR gate's cli tests now pass in the docs-site container: `bins.test.ts` no longer sees that warning, `lifecycle_own_container.test.ts` sets `WERKMEISTER_FEATURE`, and the docs-site container gets 2G (512M and 1G OOM-killed a cold cli typecheck and test run there).

## 0.43.0

### Minor Changes

- 3bd6bf5: SW-104 ready work: `werkmeister issue ready [--project <name>] [--json]` lists a project's open work in priority order, from its board's ready column in board rank when it has a board, else the scope's open issues. Issue trackers gain `listReady(board?)`. The `next-wave` skill moves into the werkmeister plugin and reads its tickets from `issue ready` on a machine with projects.
- 75bdd3d: SW-108: a post-mortem comes before close-out. `close-out` (CLI, MCP, pane, VS Code) refuses while the workspace has no `postmortem.md`, unless `--skip-postmortem "<reason>"` (MCP `skip_postmortem`) gives a reason, which goes in `closeout.md`. The new werkmeister `postmortem` skill gathers the run's problems, agrees a change for each with the person, writes `postmortem.md` and turns each change into an SW issue, standards edit or memory entry. The ICM route table, propose and spike checks, `pr-rules.md` (ICM and JIT) and `w9r-pr` send agents there before close-out, and the handoff commits `postmortem.md` to the record branch.

## 0.42.0

### Minor Changes

- ba48455: SW-105: the `/workspaces` pane's cards group their buttons by what they act on, one labelled row each: `session` (⇆ Open beside, which replaces ↗ Continue in Desktop and falls back to opening the session in place when the app won't split it; Continue in Terminal / VS Code; ＋ New session; 📌 Pin), `containers` (Up / Resume, Stop, Pause, Restart, Down, then Logs and Open feature ↗ while they run) and `work` (Refresh PRs, Open issue ↗, Close out, Abandon…). The `⋯` menu is gone. Logs opens a Terminal window following the containers' logs (new `followLogsInTerminal` in werkmeister-core). The dashboard, MCP App and VS Code are unchanged.
- a1aec1f: SW-106: the old "sandbox" name is gone. **Run `werkmeister migrate` once after upgrading.**

  Breaking:

  - The `sandbox` command is removed. Use `werkmeister` or `w9r`. Shell completion now covers both, in a `# >>> werkmeister completion >>>` block.
  - `~/.sandbox` and a workspace's `.sandbox/` are no longer read, and neither is a repo's `.sandbox/services.yaml` fragment. `werkmeister migrate` moves `~/.sandbox`, and `werkmeister migrate --workspaces` renames workspace dot-dirs. The CLI says so when it finds `~/.sandbox` without `~/.werkmeister`.
  - `SANDBOX_*` environment variables are no longer read, and every exported name is now `WERKMEISTER_*` (`env.sh`, compose, container env, `WERKMEISTER_SLOT`, `WERKMEISTER_MCP_TOKEN`, …). `migrate` regenerates `env.sh` and swaps the `~/.zshenv` block.
  - Config keys: `paths.sandbox_root` is now `paths.werkmeister_root`, and `overrides.sandbox_issues_project` is now `overrides.werkmeister_issues_project`. The `${SANDBOX_ROOT}` volume placeholder is now `${WERKMEISTER_ROOT}`. `migrate` rewrites `config.yaml`, `services.yaml` and `services.local.yaml`.
  - The `/__sandbox` selector alias is removed. Use `/__werkmeister`.
  - The legacy `sandbox-shared` network is removed (services stay on `werkmeister-shared`), the Jaeger container is now `w9r-jaeger`, and the tools dir is `/opt/werkmeister-tools`. Recreate the shared infra once (`werkmeister down infra`, then `werkmeister connect`).
  - Workspace skills are now `w9r-*` (were `sb-*`), and the generated context file is `.werkmeister/werkmeister-context.md`. The next `init-workspace` removes the old copies.

  Transition: workspaces now send `X-Werkmeister-Feature` and export `WERKMEISTER_FEATURE`. `X-Sandbox-Feature` and `SANDBOX_FEATURE` are still read, and still exported, until every workspace has re-run `init-workspace` and Playwright suites read the new name.

  Also renamed: CLI help, banners and errors, MCP tool descriptions, skills, generated `CLAUDE.md` and stage contracts, the feature selector page, the VS Code extension's titles and category, and the docs. The VS Code command, view and setting IDs keep their `sandbox.*` names, so keybindings keep working. A new `pnpm run name:check` fails CI on any new "sandbox" outside the kept names.

## 0.41.0

### Minor Changes

- 810e41b: SW-104: projects. A `projects:` map in `~/.werkmeister/config.yaml` names tracking strategies — a tracker (Jira project key, or GitHub org and optional repos), an optional board, and its own `issue_statuses` — so one machine can work on a Jira-tracked product and a GitHub-tracked one. A workspace records its project as `project:` in `workspace.yml` (`--project` on `workspace` / `init-workspace`; the create form and wizard ask after the issue, defaulting to the project whose scope holds the ref, else `default: true`), and its issue link, status moves and `pr open` / ship updates go to that project's tracker. `config --check` names invalid projects; `connect` checks each project's tracker; `config` and `setup` keep `projects:` when they rewrite the file. A machine with no projects, and a workspace with no `project:`, behave as before.

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

### Patch Changes

- 65e5b8f: SW-98: the CLI README and `main.ts` header no longer say Werkmeister runs "up to 12" features. Twelve is the default for `feature_slots.count` in `ports.yaml`, not a limit. How many features you can run at once depends on how many services each one runs locally and how much RAM you have.

## 0.38.0

### Minor Changes

- 9cf2281: SW-99: the `install-workspace-dashboard` skill is gone, along with the live-artifact build of the workspace dashboard (`workspace-list.artifact.html`). The workspaces UI is unchanged on the other surfaces: the localhost dashboard (`open-workspaces-ui`), the Claude Code mod and the Claude Desktop MCP App. If you installed that artifact, delete it and use the Desktop MCP App or the localhost dashboard instead.

## 0.37.1

### Patch Changes

- 5b37069: SW-100: Caddy starts on a fresh clone, a git worktree or an npm install. The generated `features.json` was file-bound inside the read-only `proxy/ui` mount, so Docker needed a gitignored `apps/cli/infra/proxy/ui/features.json` to exist as the mountpoint, and only old checkouts with a stale copy had one. It now mounts at `/srv/features.json`, and the Caddyfile's `/__werkmeister/features.json` handle serves it from there. The next `connect` / `up infra` regenerates the Caddyfile and recreates Caddy on the new mount. A leftover `apps/cli/infra/proxy/ui/features.json` in an old checkout is no longer read and can be deleted.

## 0.37.0

### Minor Changes

- fa98c10: SW-95: the shared-infra stack no longer says "sandbox". The compose project is `w9r-infra`, the containers are `w9r-caddy` and `w9r-k8s-forwards`, and Caddy's volumes are `w9r-infra_caddy-data` / `w9r-infra_caddy-config`. The dashboard's Jaeger and RedisInsight links point at `*.w9r-infra.orb.local`. On a machine still running the old `sandbox-infra` stack, the next `connect` / `up infra` takes it down first (its containers hold the names and ports 80/443 the new one needs) and then starts the renamed stack, so the proxy restarts once. `down infra` takes the old stack down too. Its volumes are kept unless you pass `--volumes`. Leftover `sandbox-infra_*` volumes can go with `docker volume rm`. An opted-in RedisInsight starts with empty settings, because its volume moves to the new project. Caddy's data is safe to lose: certs are bind-mounted from `certs_dir`.

## 0.36.2

### Patch Changes

- e98ce4c: In a checkout, `werkmeister mcp` now runs `apps/werkmeister-mcp/dist/main.js`. The wrapper still pointed at the MCP app's pre-rename folder. On a fresh clone that fell through to the bundled `dist/mcp.js`, but a checkout that still held an old untracked build under the pre-rename name ran that stale build, which crashed on `werkmeister-core/config` and left the werkmeister plugin's MCP server unable to connect.

## 0.36.1

### Patch Changes

- 67637e6: SW-97: `werkmeister migrate` no longer tells the person to run an `infra` subcommand, which doesn't exist. The refusal while shared infra is running now names `werkmeister down infra`, and the success message names `werkmeister connect`. A new test fails the build if any backticked `werkmeister …` command in migrate's messages isn't a registered CLI command.

## 0.36.0

### Minor Changes

- 7fa838e: SW-93: the Docker-side names and default domains no longer say "sandbox". New containers carry `com.werkmeister.*` labels, compose projects and per-feature networks are `werkmeister-<feature>`, features join the `werkmeister-shared` network, the built-in build caches live in `werkmeister-<key>` volumes, and the sandbox repo's setup service is `werkmeister-install`. A workspace brought up before this keeps running under its old `sandbox-<feature>` project and `com.sandbox.local.*` labels: slots, `status`, `stop`, `restart`, `logs`, the VS Code tree and the idle reaper all still find it, and its next `up` takes the old project down (keeping its node_modules volumes) before starting the new one. `down` and `close-out` remove both. Caddy and k8s-forwards join both shared networks, and `cache prune` also reaches a leftover `sandbox-<key>` volume. A fragment still naming its setup `sandbox-install` gets the renamed startup script. The default `local_domain`/`remote_domain` are now `local.werkmeister.io`/`remote.werkmeister.io`; a machine whose `config.yaml` sets them (every `setup` run writes them) keeps its own. The X-Feature cookie, the `connect` tool links and the docs-site's allowed hosts (a new `{{local_domain}}` registry placeholder) follow the configured domain instead of a hard-coded `local.sandbox.com`. SW-11 removes the old-name fallbacks.
- 9dfc1cc: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.

### Patch Changes

- 416ae44: A merge to main that changes only docs (`.md` files, or the docs-site app) now deploys werkmeister.io in the same CI run instead of waiting for the next package release (SW-96).

## 0.35.5

### Patch Changes

- 4250538: Close-out's handoff no longer commits untracked files (SW-91). It commits tracked changes only. Untracked files that `.gitignore` misses, such as a container's build cache, are saved to `handoff/<workspace>/<repo>.tgz` in the werkmeister home (`~/.werkmeister`, or `~/.sandbox` on an older machine) instead of being pushed. The close-out output shows each handoff commit's `--stat` and lists the files it kept. `close-out --abandon` no longer pushes a code branch that has no commits of its own; it saves the handoff commit as a `.patch` beside the tarball.

## 0.35.4

### Patch Changes

- 8dd972e: SW-90: `close-out` is safe when two runs overlap. `closeOut` takes a per-workspace lock, so a second run says `close-out of '<name>' is already running` right away. A run that finds the folder already gone, at the start or by the `closeout.md` write, says the workspace is already closed out instead of throwing ENOENT. `sandbox close-out` without `--yes` and without a terminal refuses at once ("needs --yes when not run from a terminal"). Before, it read an empty stdin and exited 130 after the prompt with no message. Any no-TTY prompt that runs out of input now says so before it exits.

## 0.35.3

### Patch Changes

- d0ca61b: The docs site is served at https://werkmeister.io instead of https://jbbz-sandbox.github.io/werkmeister/ (SW-88).

## 0.35.2

### Patch Changes

- 79953d8: Re-running the `docs-deploy` CI job no longer fails with "Multiple artifacts named "github-pages"": each attempt uploads the site under its own artifact name (SW-80).

## 0.35.1

### Patch Changes

- 6a5beae: SW-81: a hidden `werkmeister __reference` prints the commands and options as JSON. `pnpm run docs:gen` builds the users-guide command list from it, and `docs:check` reads it for the flag check.
- ac8bdaa: The public docs now build as a VitePress site (`apps/docs-site`) from the docs where they live, and deploy to GitHub Pages at https://jbbz-sandbox.github.io/werkmeister/ when a release publishes (SW-80). A broken doc link fails the site build. The README links to the site, explains `demo-services`, and `docs/jira-rest-setup.md` reads as a how-to.

## 0.35.0

## 0.34.0

### Minor Changes

- 8c99ce9: Remove the SW-9 plugin-rename compatibility shims (SW-23). The old plugin path plugins/sandbox-tools, the link that let `CLAUDE_CODE_PLUGIN_DIRS` installs keep loading the plugin under its old path, is gone: point the setting at `.../plugins/werkmeister`. Generated permission rules no longer allow or deny the `mcp__plugin_sandbox-tools_sandbox-workspace__` prefix, and existing workspaces drop those rules on their next refresh. `.mcp.json` generation no longer deletes a leftover `sandbox` MCP entry from before the rename: remove it by hand if it is still there. `w9r setup` still retires an old `sandbox-tools@sandbox` install. The dashboard's old sandbox-connect tool was already renamed `connect` in SW-48 (0.21.0), so no new Cowork reinstall is needed; an artifact installed before 0.21 still calls the old name and needs `werkmeister:install-workspace-dashboard` run again.

### Patch Changes

- 20dea5d: `sandbox-install` installs again when a workspace is re-created under the same feature name on its kept `node-modules` volume (SW-85). Each package's own `node_modules` lives in the worktree, not the volume, so the SW-33 skip now needs a second copy of its stamp in the worktree (`.turbo/.sandbox-install-hash`) to match as well. A re-created worktree, or a dropped volume, reinstalls; the build no longer fails on missing per-package deps, and `down -v` is no longer needed first. With both intact and the lockfile unchanged the install is still skipped. Each existing workspace reinstalls once on its first up after this change.

## 0.33.2

### Patch Changes

- 2922867: `werkmeister status`, the Workspaces pane and the dashboard show a stopped k8s-forwards container as neutral ("stopped — not needed by any running workspace") when no running workspace has a cluster-backed local service. Since SW-42 `up` starts the forwarder only for such workspaces, so on a werkmeister-only machine it is stopped by design. While a running workspace needs it, a stopped forwarder still shows red with the `docker restart sandbox-k8s-forwards` hint. `k8s-forwards-status` gains a `stopped` flag, and the infra tally leaves out a forwarder nothing needs, so infra no longer reads partial.

## 0.33.1

### Patch Changes

- d0367df: `werkmeister issue create` and `issue update --comment` convert Markdown to Jira wiki markup before sending it through Jira REST, so headings, lists, bold, code spans, fenced blocks and links render in Jira. Before, `## Ask` turned into a numbered list and `**bold**` stayed literal.

## 0.33.0

### Minor Changes

- cc233dc: Breaking for Node 20 and 21 (SW-77). The supported minimum is now Node 22: `engines` says `>=22` (Node 20 has been EOL since 2026-04), the bundles target `node22`, and a feature container with no `image:` defaults to `node:22` instead of `node:20.16.0`. Set `image:` in `services.yaml` to keep a different one. Upgrade the Node that runs the CLI to 22 or later (`brew upgrade node`, or `nvm install 22`).

## 0.32.0

### Minor Changes

- d2c85d1: Graduation works in icm workspaces (SW-72). Each context strategy now supplies its own decisions. In icm they are the `status: decided` sections of `stages/*/output/*.md`, one per heading, with id `stages/<stage>/output/<file>.md#<heading-slug>`. `werkmeister notes graduate`, the `werkmeister down` offer and the MCP `notes` `graduate` action scaffold them through the same `graduateNote` path jit uses. Their `graduating → graduated` state is kept in `.werkmeister/graduations.yml`, so the stage outputs are never rewritten. MCP `notes` `list` also returns the open `decisions`. jit is unchanged. The not-in-workspace error no longer names the old `.sandbox/` directory.
- 2d15fc3: Redis Insight and Jaeger no longer start with shared infra (SW-76). Redis Insight is SSPL-1.0, so it shouldn't start for everyone, and nothing in Werkmeister sends traces to Jaeger. To turn either or both back on, add their profiles to `~/.werkmeister/config.yaml` and run `werkmeister connect`:

  ```yaml
  infra:
    profiles: [redisinsight, jaeger]
  ```

  `COMPOSE_PROFILES=redisinsight werkmeister connect` works for a one-off. Containers already running from an earlier release stay up until `werkmeister down infra`, which now removes the opt-in ones too.

### Patch Changes

- ffb7834: Stop shipping `infra/compose/scripts/otel-init.bundle.js`, a 2.6 MB third-party bundle with no source or licence texts that nothing referenced.
- 3de3fbb: PR rules: squash is the default merge; a PR whose commit SHAs must survive (e.g. a `.git-blame-ignore-revs` entry) asks for a merge commit at the top of its body. `pr open` warns when the branch adds a blame-ignore SHA.
- 8925442: SW-73: `@anthropic-ai/claude-agent-sdk` is now an optional dependency. `detect --assist` prints the install command when it is missing instead of a module-resolution error.

## 0.31.0

### Minor Changes

- d3b4324: Breaking for workspaces of the werkmeister repo itself (SW-30). Its directories now match their package names (`apps/werkmeister-mcp`, `apps/werkmeister-dashboard`, `packages/werkmeister-core`, `packages/werkmeister-ui`, `packages/werkmeister-vscode`), and the services in its registry fragment follow. `sandbox-core` is now `werkmeister-core`, `sandbox-dashboard` is `werkmeister-dashboard`, and `vscode-plugin` is `werkmeister-vscode`, so containers are named `<feature>-werkmeister-core` and so on. `cli` and `apps/cli` are unchanged, so the global link and `sandbox_root` still work. There is no alias for the old ids. To migrate a workspace:

  - Run `werkmeister down <feature>` before you pull this release. If you've already pulled it, remove the leftover `<feature>-sandbox-core`, `-sandbox-dashboard` and `-vscode-plugin` containers with `docker rm -f`.
  - Run `werkmeister registry sync` from the updated main checkout. Then rename those three keys in `services.local.yaml` (in `~/.werkmeister/`, or `~/.sandbox/` on older machines) and in any `services:` list or `--services` value that names them.
  - The dashboard's host is now `werkmeister-dashboard.local.sandbox.com`. Run `werkmeister setup` from the main checkout to add it to `/etc/hosts`.
  - In a checkout, run `pnpm install` after pulling, so the workspace links follow the moved directories.

## 0.30.0

### Minor Changes

- 62e969a: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

## 0.29.0

### Minor Changes

- ca07746: Build and package caches are registry data (SW-69). A `caches:` entry gives a cache's container path, the env that points the tool at it, the lockfiles that attach it and an age or prune rule; `turbo` and `pnpm-store` are built in, and a repo can add its own. `up` creates only the shared volumes a workspace mounts, `werkmeister status` lists each cache's size and age, and `werkmeister cache prune [name]` (`--reset`, `--dry-run`, `--force`) clears them. The turbo cache moves from `~/.sandbox/cache/turbo` to the shared `sandbox-turbo` volume.

## 0.28.1

## 0.28.0

### Minor Changes

- 29bce79: The plugin's skills no longer need Python. `sandbox starting-prompt` prints the enclosing workspace's `starting_prompt` (exit 1: no `workspace.yml` found, 2: none set; `--start <dir>` to search from elsewhere) and replaces the starting-prompt skill's `get_prompt.py`. `sandbox test <feature> --scaffold` writes `playwright.config.ts` and `<feature>.spec.ts` into the workspace if missing and installs the pinned `@playwright/test`, replacing the feature-test skill's `setup_feature.py`; `--workspace` and `--base-url` carry over. Both reuse the CLI's own config, ingress and slot lookups, so the Playwright version and ingress host no longer have a second copy to keep in step.

### Patch Changes

- 803e5ca: Autonomous workspaces now allow and deny `werkmeister …` and `w9r …` commands the same as `sandbox …`. The rules were written only for the deprecated `sandbox` launcher, and a permission rule is a literal prefix, so a run calling `werkmeister up` stalled waiting for approval while `werkmeister down` slipped past the deny list. The MCP deny list no longer names `remove-workspace`, which the server dropped in #160. Rerun `init-workspace` (or `werkmeister up`) in an autonomous workspace to pick up the new rules.
- a635b75: The Workspaces pane finds `werkmeister-core` when the CLI is installed with `pnpm link --global`. pnpm's global bin is a shell shim outside the package, so the pane failed with `Cannot find module 'sandbox-core'`; it now also looks under pnpm's global folder, and the error names `WERKMEISTER_CORE_PATH` when neither works.

## 0.27.0

### Minor Changes

- bb226da: A services-registry `extra_volumes` entry can now name one Docker volume that every feature shares: write it with a leading `^` (`^sandbox-pnpm-store:/pnpm-store`). Each feature's compose mounts it unprefixed and declares it `external`, and `sandbox up` creates it if it is missing, so a package-manager store or cache is warm in every workspace. No feature's `down --volumes`, close-out or `clean` removes it; drop it with `docker volume rm <name>`. Bare names stay per-feature (`<feature>-<name>`).

## 0.26.1

### Patch Changes

- bd3169e: Workspaces' generated Claude Code permissions now allow pnpm's build and test commands (`pnpm install --frozen-lockfile`, `pnpm run`, `pnpm test`, `pnpm exec`, `pnpm turbo`) and deny `pnpm publish`, `pnpm link` and global pnpm installs, as they already did for npm. The werkmeister repo itself now builds with pnpm; installing the CLI (`npx werkmeister setup`, `npm install -g werkmeister`) is unchanged.

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

### Patch Changes

- 8fc75de: `werkmeister connect` works with Docker Compose v5. Compose now builds through `buildx bake`, which refused the k8s-forwards image's `corp-ca.crt` secret because it sat outside the directory compose ran from. Shared-infra compose commands now run from the config directory that holds the secret (`~/.werkmeister`, or `~/.sandbox` on older setups). When shared infra fails to start, `connect` now says so and exits 1, instead of printing "All 1 services healthy" for the containers that happened to exist.

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

### Patch Changes

- 3fef796: A workspace card waiting on an `AskUserQuestion` now shows the question itself instead of "Claude needs your permission to use AskUserQuestion".
- ca11609: Workspace cards no longer read Done when a Claude Desktop run is waiting on you. The agent-state hook now records a `wrap_up` box's question as needs-you, even when the closing message after it asks nothing.

## 0.24.0

### Minor Changes

- 61780d5: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.

### Patch Changes

- 138b15e: Create form (SW-51): Work type and Workflow are preselected on every GUI, labels drop the terminal hints ("blank to skip", "Enter for default") and follow docs/ui-spec.md, VS Code's New Workspace runs the wizard from the workspaces root instead of ~, and the terminal wizard requires at least one service or repo.

## 0.23.0

### Patch Changes

- f9017c7: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

- 66fcf67: Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` (the licence text of every package bundled into `dist/`) in the published package. The licence of every npm dependency is now checked against an allowlist in CI (`npm run licenses`); the full inventory is `docs/third-party.md`.

## 0.22.0

### Patch Changes

- a60c9dd: `overrides.issue_progress_status` now sets the status `issue start` moves the issue to, like `issue_review_status` and `issue_done_status` (`issue_statuses.in_progress` still wins). The workspace and sb-pr skills describe the full To Do → In Progress → In Review → Done flow.
- b1e4679: The sandbox repo's containers now share one turbo build cache at `~/.sandbox/cache/turbo` (`TURBO_CACHE_DIR`), so a commit any workspace has built restores in about a second in every install and gate run. Before, the cache sat in the main checkout's `.turbo` and the install container missed it. `TURBO_CACHE_MAX_AGE=14d` bounds the cache, and installs build one at a time so concurrent writers can't collide. Run `werkmeister registry` to pick up the new settings. The old `~/repos/sandbox/.turbo` can be deleted by hand.
- 3f0542a: `stop` and `restart` for a feature, for infra and for Caddy now go through the Docker Engine API instead of `docker compose stop`/`restart`. Containers are handled in `depends_on` order: dependents stop first, and dependencies start first. `restart` no longer re-runs a finished setup container. A failure names the container and the daemon's message. `composeStop`, `composeRestart` and `stopCaddy` are now async (SW-60).
- 95598c3: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.

## 0.21.0

### Minor Changes

- eb040c0: `werkmeister pr gate` starts one container for a touched repo that has none running, runs the tests through it, and stops it again, pass or fail. Containers that were already running are left alone. compose.yml now also lists the checked-out repos' other services behind the `on-demand` profile, which a plain `up` skips. `stop` and `down` include that profile. The gate's baseline check covers only api/web services. A workspace no longer needs every service listed to pass the gate (SW-34).
- 5f85354: Agent state tells Done, Needs you and Working apart (SW-46). Every workspace now gets a `werkmeister hooks agent-state` hook on UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd. The hook records `{state, at, question?}` in `.werkmeister/agent-state.json`. `getWorkspaceStatuses()` returns `claude.agent` (`working` · `needs-you` · `done` · `idle`), `claude.at` and `claude.question` in place of `claude.waiting`, and falls back to the transcript tail when a workspace has no state file yet. Existing workspaces pick up the hooks on their next `werkmeister up`. The workspaces pane and the dashboard show `◌ Working`, `● Needs you` and `✓ Done`, so a finished run no longer reads "waiting for you".

## 0.20.0

### Minor Changes

- 002e00f: Every generated workspace container gets a CPU limit (`cpus` 1.0, 2.0 for setup services such as sandbox-install), overridable per service, setup service or `extra_services` entry with `cpus:` in services.yaml. `werkmeister stats` and `werkmeister optimize` show each container's CPU limit (SW-40).
- a0bc792: One MCP server (SW-48). `werkmeister mcp` now serves every tool, including the dashboard's, over stdio and over HTTP on :3002, with one name per verb and no aliases. The plugin's server is `werkmeister` (tools `mcp__plugin_werkmeister_werkmeister__*`), not `workspaces`. Renamed: `workspace-status` → `status`, `workspace-action` → `up` / `stop` / `restart` / `down`, `sandbox-connect` → `connect`, `open` → `open-feature`, `remove` → `remove-service`, the `workspace` form tool → `create-workspace-form`. Workspace-scoped tools take one `workspace` argument (directory or feature name) in place of `name` / `feature`. `werkmeister dashboard` now runs the localhost browser dashboard and no longer serves MCP. Update a Claude Desktop entry to `{ "werkmeister": { "command": "werkmeister", "args": ["mcp"] } }`.

### Patch Changes

- 3c922d4: `werkmeister status` and the infra, k8s-forwards and Caddy health checks read containers from the Docker Engine API by compose label instead of shelling out to `docker compose ps` (SW-59). `status` no longer prints a `Running: docker compose … ps` line per feature, so `status --json` is valid JSON again, and it no longer generates the k8s-forwards override as a side effect.
- 012322f: A service in `services.yaml` can set `dockerfile:` to build its image from a Dockerfile in its `path` (tagged `image:`), instead of only pulling a prebuilt one. The sandbox repo's `vscode-plugin` service uses it to bake in xvfb and Electron's libraries, so `npm run test:integration` runs in a fresh container (SW-62).

## 0.19.0

### Minor Changes

- 1e7d8a7: `werkmeister setup` offers to schedule `werkmeister pr watch` every 10 minutes (launchd on macOS, crontab elsewhere); `werkmeister pr watch --install` / `--uninstall` add or remove it. Logs go to `~/.werkmeister/pr-watch.log` (SW-14).

## 0.18.0

### Patch Changes

- bd22bce: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- bfd0e9d: Minify the published CLI bundle (`minify: true`, `keepNames: true`) so the package is smaller and loads faster. Function and class names stay in stack traces, third-party license notices stay in the bundle, and `.map` files stay out of the package (SW-58).
- 9420fd0: The built-in compose fallback now names feature containers `<feature>-<svc>`, as the template does, instead of `sandbox-<feature>-<svc>`. Both paths and the PR gate's container lookup share one `containerOf(feature, svc)`, so a workspace generated through the fallback has containers the gate, restart lines and allow rules can find.

## 0.17.1

### Patch Changes

- caca3dc: Adopt the Apache License 2.0 (SW-17): add `LICENSE` and `NOTICE`, and set `"license": "Apache-2.0"` in every package manifest. No behavior change.

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
- fae86b3: The sandbox repo's `sandbox-install` setup service no longer reinstalls and rebuilds on every `up` (SW-33). It skips `npm ci` while the lockfile and Node major version match a stamp in the node_modules volume. The stamp is written only after a successful install, so a failed one retries. The service now mounts `~/repos` with `safe.directory`, so turbo restores the build from the main checkout's shared cache. At most `SANDBOX_INSTALL_SLOTS` (default 2) installs run at once host-wide, queued through `~/.sandbox/locks`. Run `werkmeister registry` after upgrading to pick up the new command; until then the old one runs unchanged.
- 65ff7f9: `werkmeister up` no longer fails when the kube context exists but its cluster is switched off. The k8s port-forwards are skipped with a warning when the API server doesn't answer, so features that need nothing from the cluster come up normally (SW-28).

## 0.15.0

### Minor Changes

- f85e6af: Rename the Claude Code plugin `sandbox-tools` to `werkmeister` and its marketplace `sandbox` to `werkmeister` (install id `werkmeister@werkmeister`). The seven `sandbox-*` skills drop the prefix (`/werkmeister:diagnose`, `:workspace`, `:feature-test`, `:status`, `:caddy-reload`, `:routing-test`, `:starting-prompt`). The plugin's MCP server `sandbox-workspace` is now `workspaces` and runs `w9r dashboard`, so its tools are `mcp__plugin_werkmeister_workspaces__*`. The headless registry server `sandbox` is now `werkmeister`, and its tools drop the prefix (`sandbox-up` is `up`, `sandbox-status` is `status`, `sandbox-workspace` is `workspace`, and so on). The dashboard's `sandbox-connect` tool keeps its name.

  An existing install does not move by itself. Run `w9r setup`: it installs the new plugin, then removes `sandbox-tools@sandbox` and the `sandbox` marketplace (`w9r setup --check` flags the old one). `plugins/sandbox-tools` stays as a link to the new directory for one release, and generated permission rules allow both the old and new tool prefixes for one release. Manual steps, including Claude Desktop, are in `plugins/werkmeister/README.md`.

## 0.14.1

### Patch Changes

- 186e6d3: Renamed the internal workspace packages to match the CLI (SW-6): `sandbox-core` is now `werkmeister-core`, `sandbox-mcp` is `werkmeister-mcp`, `sandbox-workspace-mcp-app` is `werkmeister-dashboard`, the root `sandbox` is `werkmeister-monorepo`, and `vscode-plugin` is `werkmeister-vscode`. None is published, and the CLI bundles the core library, so the CLI's behaviour is unchanged. Directories, registry service names and container names keep their old names.

  The VS Code extension id follows its package name: `jbbz.vscode-plugin` is now `jbbz.werkmeister-vscode`. `sandbox setup` looks for the new id, so a machine with the old extension installed gets the new one installed beside it. Uninstall `jbbz.vscode-plugin` by hand.

## 0.14.0

### Minor Changes

- 6ff0f46: The Caddy feature selector is now served at `/__werkmeister` (SW-8). `/__sandbox` keeps working as an identical, deprecated alias until SW-11 removes it. The `X-Feature` cookie and header are unchanged.
- 8399b4d: Workspaces pane: each running service shows its Telepresence intercept state and an Intercept / Leave toggle (confirm on start). `sandbox status --intercepts --json` now returns an empty `intercepts` list when telepresence is unavailable.
- 99f1477: Renamed the CLI package (formerly `sandbox-cli` under the `@jbbz-sandbox` scope) to the unscoped `werkmeister` (SW-5). It ships two bins, `werkmeister` and `w9r`. The old `sandbox` bin still works but is deprecated: it prints a one-line notice on stderr, then runs as before. It will be removed in SW-11.

  To migrate, uninstall the old scoped package globally, then run `npm install -g werkmeister`.

- 1c3f210: Sandbox-tool issues can go to Jira: set `overrides.sandbox_issues_project` (e.g. `SW`) under `issue_tracker: jira` and the generated issues guide routes them, and the search step, to that project instead of GitHub (unset keeps GitHub). New `sandbox issue create --project <KEY> --type bug|feature|task --title ... --body-file ...` files a Jira issue over REST and prints its URL; a project without the mapped type (Bug) gets a Task labelled with it. The guide's app-code row under Jira now uses it too. Jira REST errors now include Jira's reason.
- 7e0a144: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- 99a2303: `sandbox pr open` no longer moves the issue to a hardcoded "In Development". It moves it to `overrides.issue_review_status` from `~/.sandbox/config.yaml`, defaulting to "In Review", which matches the usual To Do → In Progress → In Review → Done workflow. On GitHub, the label of that name is added as before.
- 3fc83a3: The CLI is now published to npmjs.com as `werkmeister` instead of GitHub Packages. Install with `npx werkmeister setup` or `npm install -g werkmeister`, with no registry or token setup. Releases publish through npm trusted publishing from GitHub Actions, so no npm token is stored.
- acf3e20: The GitHub repository is now `jbbz-sandbox/werkmeister` (SW-10). The package's repository URL, the sandbox-tool issue repo in generated issue-filing guides, the plugin marketplace source written by `setup`, the schema `$id`s and the docs all point there. GitHub redirects the old `jbbz-sandbox/sandbox` URLs, so existing clones and links keep working.

## 0.13.0

## 0.12.0

### Minor Changes

- e12539a: PR callbacks (#236): `sandbox pr open` records the Claude Code session that opened each PR (`session`, plus `host_session` in the desktop app), and that session is told once when the PR merges, ships or closes. Desktop sessions are reached through the app by the sandbox-tools mod, which checks every 10 minutes; terminal sessions are resumed headlessly by the new `sandbox pr watch` (run it from cron). It never merges or closes out.
- 7963500: Workspaces take an opt-in `auto_stop` (#231): `--auto-stop` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_AUTO_STOP`, `auto_stop: true` in `workspace.yml`, or the create form's checkbox. It writes a managed SessionEnd hook to the workspace's `.claude/settings.json` (hand-added hooks are kept; turning it off removes only sandbox's entry) that runs the new `sandbox stop --if-idle`: when the session ends and no other Claude session is open in the workspace, the workspace's own feature containers stop in the background, keeping the slot and volumes so `sandbox up` resumes fast. It never stops shared infra, prints nothing and always exits 0. `sandbox-context.md` says so in Container Lifecycle while it is on. Workspaces without `auto_stop` behave as before.

### Patch Changes

- 9a3e19a: Workspace `docker compose` calls now pass `-p sandbox-<feature>` (#225). Running `sandbox workspace` inside another workspace's container no longer builds the new workspace's images under the caller's `COMPOSE_PROJECT_NAME`, so the caller's containers are no longer recreated or removed and the new containers carry their own project label. Covers the init build, every `compose.ts` lifecycle/logs call, and the VS Code log tail (#198 fixed the same leak for infra only).

## 0.11.0

### Minor Changes

- 0f2892d: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- 21c5815: Workspaces take an optional `model` (#233): `--model <alias|id>` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_MODEL`, `model:` in `workspace.yml`, or the create form's new field. It is written to the workspace's `.claude/settings.json` (a model set there by hand is never overwritten, and clearing `model` removes only the value sandbox wrote), passed as `--model` by `claude-send` and `claude-resume`, and returned by `list-workspaces` / `workspace-status`. Workspaces without a model behave as before.

## 0.10.1

## 0.10.0

### Minor Changes

- 93adb9a: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

## 0.9.1

## 0.9.0

### Minor Changes

- 5d23026: `sandbox pr gate`: a repo's registry `repo:` block can list `no_service_paths` (e.g. `docs`, `.changeset`, `README.md`); changes under them touch no service, so a docs-only PR no longer needs `skip_tests` for every service. The sandbox repo declares `docs`, `.changeset`, `.gitignore` and `README.md`.
- 547a405: `sandbox pr adopt <pr-number|url> [repo]` closes out a workspace whose fix landed somewhere else. It writes the PR file from `gh pr view` and records its status, so a merged PR is promoted to `shipped` with its release tag. `sandbox pr adopt --no-pr "<reason>"` covers a fix that is already on base with no PR: it writes a `closed` PR file with the reason. Close-out doesn't delete an adopted PR's branch. A PR file whose frontmatter isn't valid YAML now reports the parser's error.

### Patch Changes

- 80063a1: An `autonomous` workspace's allow list now includes `claude plugin validate` and `claude plugin test`, so a headless run can check a plugin's pane tests itself. A blanket `claude plugin:*` rule is still not granted, since it would also allow installing and uninstalling plugins.
- 59c0926: `sandbox workspace` without `--context-strategy` (and every other non-interactive create: MCP, dashboard) now writes `context_strategy: icm` to the new `workspace.yml` instead of leaving the key out, which read as `jit`. Existing workspaces without the key still read as `jit`.
- 33c365e: A CLI linked from a checkout now warns on stderr when its `dist` bundle was built from a different commit than the checkout's `HEAD`. The warning names both SHAs and the rebuild command. Published installs and `sandbox hooks` skip the check.

## 0.8.0

### Minor Changes

- a05691d: New workspace input `autonomous` (`--autonomous`, `SANDBOX_AUTONOMOUS`, `autonomous: true` in `workspace.yml`, or a checkbox in the create form, the terminal wizard and the `/workspaces` pane; off by default). When it is on, an icm workspace runs from stage 01 to `sandbox pr open` with no human check. Each stage contract ends in a `## Self-check`, the agent sets its own PR file to `approved` and records its decisions under `## Recommendations for reviewer`, and `CLAUDE.md` lists only three stop points: the PR URL, a question only a person can answer, or a gate failure outside the issue's scope. For both strategies, `.claude/settings.json` gets the Bash allow rules a headless `claude-send` session needs (`git`, `sandbox`, `docker`, `gh`, `node`, `npm`, `npx`, `python3`, read-only utilities) and the sandbox-workspace MCP server. These rules are recorded in `.sandbox/claude-permissions.json`, so turning `autonomous` off removes them. The PR guard still blocks `gh pr create`, and `sandbox pr gate` still applies. (#175)
- 2a12a15: New workspaces default to `context_strategy: icm`. The wizard, browser form and `sandbox workspace` / `init-workspace` without `--context-strategy` now pick `icm`; pass `--context-strategy jit` for the JIT layer. A `workspace.yml` that has no `context_strategy` key still reads as `jit`, so existing workspaces are unchanged.
- c0f5f84: Workspace PR rules (`pr-rules.md`, the ICM router and the `workspace-pr` / `sb-pr` skills) now turn on the desktop app's Auto-fix for each PR right after `sandbox pr open`, instead of offering it. Auto-merge stays off.

### Patch Changes

- 864907c: docs(users-guide): list all four GraphQL service types (`graphql-subgraph`, `graphql`, `subgraph`, `federation`) that turn on supergraph generation, matching the code and the architecture doc.

## 0.7.0

### Minor Changes

- 821c80a: Every workspace's `.claude/settings.json` now gets `permissions.allow` rules for its services' registry test commands (the `docker exec` line `sandbox-context.md` prints, plus the bare command) and read-only git (`git diff`, `git status`, `git ls-files`), for both context strategies, on init and every `sandbox up`. Sandbox records the rules it added in `.sandbox/claude-permissions.json` and only ever removes those; hand-added rules are kept. `sandbox setup` gains an optional step that grants Claude Code read access to the standards dir in the user-level `~/.claude/settings.json` (`permissions.additionalDirectories`), so no machine path lands in a workspace; it asks first, and `--yes` never grants. (#144)

### Patch Changes

- ace07f6: `sandbox pr gate` accepts `skip_tests: { <service>: <reason> }` for a service that has a test command but no running container for its repo, so a workspace that runs no containers for the PR's repo can pass the test check. `sandbox pr status` no longer marks a `ship: tag` repo's PR `shipped` on merge because `skip_release` is set; it waits for a release tag containing the merge commit. (#145)
- 80b996f: `sandbox up` no longer accepts `-s/--services` or `--force`. It never read them: `sandbox up -s <service>` exited 0 with nothing started and no warning. Both are now rejected as unknown options. To run a service locally, add it to `.sandbox/workspace.yml`, run `sandbox init-workspace`, then `sandbox up` (#153).

## 0.6.0

### Minor Changes

- f723a0a: Validation guidance for services without a URL. `services.yaml` gains a `validate:` field (a service's own value beats its archetype's; defaults ship for `node-tool` and `mcp-client`), and `sandbox-context.md` opens with a How to validate table per service, rendering routing, Caddy and cookie sections only when a URL-addressed service needs them. `sandbox test` looks for a Playwright config in the workspace root, then each repo worktree; with no suite it runs nothing and prints each service's test command and validation instead. Fragments accept `type: extension`.

### Patch Changes

- `sandbox setup` now prunes `/etc/hosts` entries and certificate SANs for services no longer in the registry, and `sandbox setup --check` reports them as stale (before, it only caught missing hostnames). Ingress hosts entries now live in a managed `# BEGIN sandbox ingress` … `# END sandbox ingress` block. The first run moves existing `127.0.0.1` lines under the ingress domains into it, and leaves every other line alone. Fixes #105.

## 0.5.1

## 0.5.0

### Minor Changes

- 3f11a3c: One workspace-create pipeline: every entry point (`sandbox workspace`, `--browser-form`, the MCP `workspace` / `create-workspace` tools, the /workspaces pane) goes through `createWorkspace`, which fetches the issue (failing the create when it can't be read), stores it in `.sandbox/issue.md`, and renders the same `## Issue` section in ICM and JIT. New `sandbox init-workspace --refresh-issue` and `sandbox workspace --no-distill`; `sandbox connect` checks issue-tracker sign-in; a placeholder Jira `base_url` counts as unset.
- 3a8a66d: Workspace PR lifecycle (docs/workspace-lifecycle.md): per-repo PR files with an approve flip, `sandbox pr gate|open|status` (pre-PR gate runs the registry test commands, exercise evidence and the repo's release check), a PR-guard hook that blocks `gh pr create` and `/create-pr` inside a workspace, `sandbox close-out`, `remove-workspace --abandon`, a registry `repo:` block for ship detection, and lifecycle state on the workspaces pane. ICM's `ship` stage is now `propose`, and `verify.md` is now `exercise.md`.

### Patch Changes

- 0986e76: `sandbox registry sync` no longer aborts with "defined by both" when a linked git worktree of a repo sits under `paths.repos_root`; worktrees are skipped and only main checkouts are read (jbbz-sandbox/sandbox#136).
- 3abaaee: sandbox-feature-test: `setup_feature.py` resolves the workspace through `paths.workspaces_root` like `resolveWorkspace` does, so running it from a workspace root (itself a git repo) no longer scaffolds `playwright.config.ts` and the spec into the workspaces root (#107).
- 9d48be0: The create form's rules live in sandbox-core (`validateFormData`, `repoSelectionError`, `mergeFormData`), shared by the browser form and the /workspaces pane. The pane now refuses Create without a service or repo instead of failing later in provisioning.

## 0.4.0

### Minor Changes

- `sandbox setup` asks for the issue tracker (`overrides.issue_tracker`: `jira` or `github`). With `github`, issues are per repo and the tracker spans every repo in the services registry under `github_org`: `sandbox workspace` asks for a GitHub issue (`repo#n`, `owner/repo#n` or an issue URL; `--github-issue`) instead of a Jira ID, `CLAUDE.md` links it, and the issues guide sends app-code issues to those repos' issues. With `jira`, the issues guide sends them to the workspace ticket's Jira project. Jira links now use `jira.base_url` instead of a hardcoded site.
- The `sandbox workspace` terminal wizard now renders from the same RJSF form schema as the browser form and MCP UI, so every surface shows the same fields, choices and validation. Local-service choices are listed under the repo that owns them in both the wizard and the create form. Removed `--print-prompts` and `--print-form-schema` from `workspace` and `init-workspace`; the form schema is built in-process by `getFormSchema`.

### Patch Changes

- `sandbox setup` run from a checkout now says why it can't install the VS Code extension (no bundled `.vsix`) and points at building it from `packages/vscode-plugin`. The README documents installing the CLI from a clone with `npm link -w apps/cli`.

## 0.3.0

### Minor Changes

- Everything `sandbox connect` generates now lives under `~/.sandbox/infra/` instead of inside the CLI package: the Caddyfile, `features.json`, the pinned kubeconfig, the k8s forwards table, and (new) a `compose/k8s-forwards.override.yml` carrying the `k8s-forwards` ports and aliases that used to be rewritten in place inside `shared-infra.yml`. A global `npm install -g` therefore works on a root-owned prefix, and an upgrade no longer deletes a file a running container is mounting. **After upgrading, run `sandbox connect` once**: `docker compose` recreates `sandbox-caddy` and `k8s-forwards` on the new mount paths. The `sandbox-tools` skills read the Caddyfile from the new location.
- The headless MCP server (`apps/mcp`) is bundled into the CLI package as `dist/mcp.js`, so `sandbox mcp` and the MCP server `sandbox connect` starts on 3002 work from an `npm install -g` with no checkout. `sandbox dashboard` falls back to that bundle when the workspaces dashboard app is absent, which keeps the `sandbox-tools` plugin's MCP entry serving the `sandbox-*` verbs on a package install; the dashboard itself (Jira, PRs, MCP-App UI) stays checkout-only. `sandbox connect` no longer prints a dashboard URL it did not start. Sourcemaps are dropped from the tarball. The sandbox-diagnose and sandbox-caddy-reload skills no longer import `dist/lib/caddy.js`, which the bundle never emitted.
- `sandbox detect` now generates a repo's `.sandbox/services.yaml` from its package manifests, Dockerfiles, docker-compose files, Helm charts, k8s manifests and kustomize overlays, and re-runs only add what is missing. `--assist` asks Claude about the fields the scan had to guess. The old changed-service report is gone; the `sandbox-detect` MCP tool now returns the proposed fragment and writes it with `write: true`.
- The Sandbox Workspaces VS Code extension ships in the CLI package as `dist/sandbox-workspaces.vsix`, and `sandbox setup` offers to install it (section 8, now "VS Code"). It is versioned with the CLI, so a re-run upgrades a stale install and `--check` reports one. Only the packaged `.vsix` is ever installed — a checkout has none, since `prepack` builds it, not `build`.

## 0.2.0

### Minor Changes

- `~/.sandbox/services.yaml` is now generated from each repo's `.sandbox/services.yaml` fragment. `sandbox setup` scans `paths.repos_root` after cloning, merges the fragments under the sandbox's archetype/MCP defaults and over a new per-machine `~/.sandbox/services.local.yaml` (which now holds `k8s_context` and any hand edits), and writes the registry. New `sandbox registry sync` / `sandbox registry --check` run that step alone. A pre-existing hand-written registry is backed up to `services.yaml.bak-<ts>` on the first run; move its entries into the owning repos' fragments. The demo and empty registry seeds are gone: with no fragments found, setup says so instead of writing a skeleton.

### Patch Changes

- claudeck is gone from this repo for good: `sandbox connect` no longer tries to start it (it lives in its own repo and starts itself), the `claudeck` self-host service is dropped from the sandbox registry fragment, and the `claudeck:sync` script moved with the folders merge into claudeck's workspace plugin.

## 0.1.3

### Patch Changes

- `.sandbox/workspace.yml` gains a `context_strategy` field (`jit` or `icm`, defaulting to `jit`) that selects which context layer `init-workspace` generates and `up` refreshes. `sandbox workspace` and `sandbox init-workspace` gain a matching `--context-strategy` flag (env: `SANDBOX_CONTEXT_STRATEGY`).
- `sandbox code [feature]` opens a workspace in VS Code, using the same `openWorkspace` call as the dashboard's `open-workspace` tool. With no argument it reads `FEATURE` from a `.env` file.
- `sandbox skills`, `sandbox notes context` and `sandbox hooks gate` now dispatch through the workspace's `context_strategy` instead of assuming jit. `skills check`'s success line reads `Context layer fresh (<id>).`, and the "lags" hint now fires whenever the strategy's `check()` reports anything (previously only on drift). The MCP `sandbox-skills` tool returns `{ drift: string[] }` for `check` and `{ wrote: string[] }` for `sync`; `sandbox-hooks` now refreshes the workspace's context layer (jit: re-merge hooks; icm: remove sandbox-managed hooks) and returns `{ strategy: string }` instead of a hook file path. `sandbox-workspace`/`sandbox-init-workspace` gain a matching `context_strategy` argument.

## 0.1.2

### Patch Changes

- Phase gate: in a `feature` workspace, the PreToolUse gate denies source edits until a `decision` note in `.sandbox/notes/` reads `status: decided`; in a `bugfix`/`incident` workspace, until a `finding` note exists. `init-workspace` compiles the gate into `.sandbox/standards.json` as `phase_gate`; `sandbox skills sync` keeps it up to date but never adds it to a workspace that doesn't have it yet. Edits under `.sandbox/` are never gated, and the gate fails open on anything it can't read.
- The workspace's `work_type` now selects its JIT phases. The generated `CLAUDE.md` shows a **Work type** line, a **Gate** line and only that type's By-phase rows (a `refactor` has no research row, a `spike` only research, `bugfix`/`incident` skip review), and the seeded handoff starts at the type's first phase. `sb-research` ends a `feature` in a `decision` note with `status: decided` that records the user's answers and the approved design, and ends a `bugfix`/`incident` in a `finding` naming the root cause. An empty or unknown work type renders as before.

## 0.1.1

### Patch Changes

- Route the last ten direct `console.*` writes in `sandbox-core` (`compose`, `browser`, `safari`) through the reporter, so a library import can no longer corrupt `sandbox mcp --stdio`'s JSON-RPC stream. CLI output is unchanged, byte for byte.
- The dashboard's workspace up/stop/restart/down now call `sandbox-core/lifecycle` in-process instead of spawning the CLI, using a new `collectingReporter()` to build the transcript they return. Adds guards for a workspace with no `FEATURE` and for `FEATURE=infra`, and reloads the proxy after `down` (which `lifecycle.down()` does not do).
- The k8s port-forward container now retries the cluster check at startup and exits non-zero if it never succeeds, instead of sleeping forever. Sleeping disarmed the `restart: unless-stopped` policy, so losing the boot race against the cluster left every forward dead until someone restarted the container by hand.
- `sandbox up` can now actually repair an unhealthy k8s-forwards container. It ran `docker compose up -d`, which is a no-op for an already-running container — so the repair reported success without doing anything, and `up` then waited out its timeout for tunnels that were never coming back.
- `sb-research` gains the delegation rule (delegate for a conclusion, read inline what a correctness claim rests on), and `sb-implement`'s test-log example no longer teaches a loose `grep -i 'fail|error'` — that pattern returns 158 matches on a passing run of this monorepo's own suite.
- Ship `infra/compose/scripts/sandbox-install-startup.sh` (docker/compose/kubectl into a feature tools volume) and let the dashboard bind `HOST`, so the sandbox repo's own apps and packages can run as sandbox services.
- Workspaces carry only the context their sessions use. `init-workspace` seeds the `starting_prompt` handoff even after an older placeholder (which it marks superseded), and projects only the workspace's active `sb-*-standard` skills. The generated `CLAUDE.md` drops the Feature Testing section and the service map, and `sandbox-context.md` is scoped to the workspace's own hosts with the feature URL. The tester agent runs a proxy smoke check, the researcher agent carries the investigation method, and `sb-research` is a thin dispatcher.

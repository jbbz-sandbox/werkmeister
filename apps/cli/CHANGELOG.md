# @jbbz-sandbox/sandbox-cli

## 0.99.0

### Minor Changes

- 3d5fed3: A metrics event log at `~/.werkmeister/metrics/events-YYYY-MM.jsonl` (SW-775): append-only, one JSON line per event, local only. The first events are `queue.wait`, written the first time a feature waits for capacity, and `queue.admit` with `waited_s`, written when that wait ends in an admit. Lines follow `docs/superpowers/specs/2026-11-15-metrics-events.schema.json`.

## 0.98.0

### Minor Changes

- d22467a: VS Code and the dashboard read the workspace state model (SW-558). The VS Code card shows the phase, the activity and every needs-you item, the PR poll's included; the dashboard's Health rows show the same chip, phase, activity and needs list as the /workspaces pane. The agent word (Working, Needs you, Done, Idle) is now `workspaceState.agent { id, since }`.

  **Breaking:** `WorkspaceStatus.claude` keeps only `state`: `claude.agent`, `claude.at` and `claude.question` are gone, and so is the MCP `status` tool's `claude.agent` enum. Read `workspaceState.agent` for the word and `workspaceState.needs` for what it waits on. The pre-SW-487 `.werkmeister/agent-state.json` `sessions{}` is no longer read. Upgrade the VS Code extension with the CLI: an older extension reads `claude.agent` from this daemon's `status` and its Workspaces view fails to load.

### Patch Changes

- 97a54c0: The card's `Running in background: …` label names a werkmeister command only at the start of a command, and takes a second word only for a command group: `git -C werkmeister log` reads as that command, and a command's argument is no longer read as its second word (SW-690).

## 0.97.0

### Patch Changes

- 29a14c0: SW-888: on macOS and Windows the host-load wait (a setup start in `feature up`, `with-temp-home`, the gate's retry) reads the Docker VM's load from a one-shot `alpine:3` container in place of the host's own load average, which never sees the VM (macOS) or is always 0 (Windows). A busy VM now holds back a setup start as host load does on Linux; an unreadable VM counts as not busy. `budget status` says `(Docker VM load on macOS)` or `(Docker VM load on Windows)`.

## 0.96.7

### Patch Changes

- 358991f: `werkmeister machine setup` offers the demo apps only when a kube context is set, and says why it skipped them otherwise: their backend reaches Postgres and Redis through the cluster, so without one `feature up` could not start them. Quick Start says the same (SW-641).
- 1cc32fc: The `github_ingest` AWS key pair now lives in `~/.werkmeister/secrets.env` (`GITHUB_INGEST_ACCESS_KEY_ID`, `GITHUB_INGEST_SECRET_ACCESS_KEY`) instead of `~/.werkmeister/config.yaml`, so reading the config to check a setting no longer prints credentials. `werkmeister machine config --write` and `werkmeister machine setup` move keys still in config.yaml there, and the daemon reads either place until then (SW-759).
- 9d6f002: `werkmeister machine config <args>` and `werkmeister machine setup` keep every top-level section of `~/.werkmeister/config.yaml` they don't ask about, such as `budget:`, `models:` and `github_ingest:`. Before, both rebuilt the file from a fixed key list and dropped any other section (SW-852).
- 4d1c6be: With `WERKMEISTER_CONFIG_FILE` pointing somewhere other than the default home, or with `WERKMEISTER_FIXTURE=1`, `werkmeister machine config --write` and `werkmeister machine setup` leave `~/.zshenv` and `~/.zshrc` alone and say so, and `--check` no longer reports `~/.zshenv` as drift for such a home. The default home still gets both blocks (SW-866).
- a1332f3: `werkmeister machine detect` fits Dockerfile repos better. A single-stage Dockerfile that runs `RUN`, `COPY` or `ADD` gives `dockerfile:` and a `<repo>:local` image instead of its base image. A service with no port in any source, or whose command is `sleep infinity`, is guessed `type: cli` and marked for a person to confirm, instead of `type: api` on port 3000. A compose service with no build context is matched by its relative bind mount (`.:/app`). Validation errors print as errors under "Not written", and the report names each service with no test command (SW-928).
- 5d6f6b4: Re-running `werkmeister machine detect` no longer proposes an `infrastructure:` entry for a compose datastore the fragment already runs as a local service (`image:`), matched by name or by the host the service's existing env URL uses. It no longer proposes `command: sleep infinity` for an idle type (`cli`, `library`, `extension`), which already idles (SW-934).

## 0.96.6

### Patch Changes

- 310bb9f: The daemon's `/mcp` keep-alive now follows `WERKMEISTER_DAEMON_HEARTBEAT_MS` (default 60 s, as `/api/tool`) instead of the MCP SDK's own 15 s default, so an SDK update can't drop it and a tool call that is quiet for more than 5 minutes still stays under undici's body timeout (SW-722). Calls never failed this way today; no session needs to reconnect.
- fabb312: A service's `depends_on` on another checked-out service now starts that dependency (SW-942). A workspace service's dependency is rendered as a workspace container, with its env file and secrets, so `werkmeister feature up` starts it, and so does the PR gate's service start. Before, it sat behind the `on-demand` profile, and the service's test failed with `could not translate host name` until `feature up --service <dep>`. An on-demand service now keeps its on-demand dependencies, so `feature up --service <svc>` starts them too. A dependency outside the workspace's checked-out repos (k8s or baseline) is unchanged.
- a1d2a99: An `extra_services` sidecar is no longer Redis-only (SW-933). It takes `health_endpoint` (`redis`, the default and today's `redis-cli ping`; `postgres` for `pg_isready`; an HTTP path; or `""` for no healthcheck), `environment` and `extra_volumes`, and `command` is now optional. So a postgres sidecar with a password, a database and a mounted init script can be declared in the registry instead of as a second full service.
- 2d0ccc1: In an autonomous workspace, `werkmeister pr gate` (and `pr open`, which runs it) run by an agent or through the daemon (the `workspace-pr` MCP tool, the pane), anything but a person's terminal, no longer recreates a service that mounts the docker socket, the werkmeister home or a workspaces root when the branch's fragment changes its `command`, `image`, `build`, `entrypoint`, `archetype`, mounts or `environment`. The gate fails with a `start <service>` row instead, and the person runs `werkmeister pr gate` from their own terminal. Before, a changed `command:` ran as root with those mounts, past SW-854's start rules (SW-891).

  A fragment whose service `path` has a `..` segment now fails the registry merge: compose mounts `<repo>/<path>/src` read-write, so it reached another workspace.

- 62322a9: In an autonomous workspace, `werkmeister pr status` no longer pulls the source checkout and syncs the machine registry for a merged PR under `sync_on_merge: auto`. It prints the `registry sync needed` notice as `warn` does, since the agent can edit the PR file that asks for the sync; run `werkmeister registry sync` yourself (SW-892).
- 00b7c49: An autonomous workspace's `git commit` rule now takes the message on the command line only: `git commit -m`, `-qm`, `-q -m`, `--amend -m`, `--fixup` and exact `--amend --no-edit`, bare or `-C <own repo>`. `git commit -F <file>` asks, since it read any host file into a commit that the pre-approved `pr open` pushes, and `--pathspec-from-file` is denied, since its error prints the file's lines (SW-893).
- a3700f1: The edit gate's hook no longer treats your home folder as a workspace because `~/.werkmeister` is there: a session under `~` outside any workspace resolves no workspace (SW-897).
- d17b618: An interactive workspace now pre-approves the same `git commit` forms as an autonomous one (`-m`, `-qm`, `-q -m`, `--amend -m`, `--fixup`, exact `--amend --no-edit`), bare and `-C <own repo>`, and denies `--pathspec-from-file`. Before, it had only read-only git, so each stage's commit rested on auto mode's classifier, which could refuse it mid-stage. `werkmeister machine migrate` or `werkmeister workspace init` brings an existing workspace's rules up to date (SW-912).
- 90aeb7c: `overrides.telepresence: false` in `~/.werkmeister/config.yaml` keeps werkmeister from starting `telepresence` on its own (SW-920). The `/workspaces` pane, `feature status` and the `intercepts` tool show no intercepts, `feature down` leaves none, and `werkmeister infra intercept` fails with `TELEPRESENCE_DISABLED`. `infra intercept --leave` still runs, to remove an intercept left from before. Unset or `true` keeps today's behaviour.
- 1af4607: A workspace container now mounts its git worktree's admin dir (`<repo>/.git/worktrees/<name>`) read-write instead of read-only (SW-785). In a container that also mounts the main checkout (as werkmeister's own werkmeister-core does), a git command that writes the index (`git checkout -- <file>`, `git reset`) now works instead of failing with `index.lock: Read-only file system`. It takes effect once a workspace's compose.yml is regenerated.

## 0.96.5

### Patch Changes

- 28e90fe: `werkmeister pr status` in a changesets repo records, at merge, the public packages the PR's own changesets name (`release_packages:`). It marks the PR shipped only once each of those packages has a `<pkg>@*` release tag. Until then it reports `partially released: <pkg> missing`, and neither moves the issue to Done nor prompts a close-out (SW-712).
- 94be723: The published werkmeister-core package no longer ships the test fixtures `fixture_fakes` and `fixture_workspace`. The `with-fixture-workspace` wrapper writer that init uses moved to `werkmeister-core/temp_home` (SW-714).
- 8583542: `werkmeister issue start` reads a linked checkout as current when the only commits it lacks from `origin/main` are changesets "version packages" commits (CHANGELOG.md files, deleted `.changeset/*.md`, and `"version"` lines in package.json). A run no longer stops to rebuild a CLI whose code is the same. Any other missing commit still reads stale (SW-719).
- 66f289d: The `werkmeister-core/sdk` entry now exports the types its public members use, so callers can name them: `Runner`, `Deps`, `InitContext`, `CacheRegistry`, `CacheEntry`, `CacheSnapshot`, `RunResult`, `HostLookup`, `ContainerStats`, `Recommendation`, `ServiceUsage`, `ServiceEndpoint`, `Usage`, `HostSummary`, `FeatureSnapshot`, `InfraContainer`, `ForwardStatus`, `WebServerStatus`, `InterceptRow`, `DecisionSource`, `StrategyId`, `IssueSnapshot`, `QuestionKind`, `ResolvedService`, `ResolvedInfra`, `HooksSupport` and `HarnessId`, plus `stdoutRunner`, `portsPerSlot`, `defaultDeps` and `GraduationError`. Other contract fixes:

  - `infraDown`, `infraStop` and `infraRestart` resolve `true` or `false`, as `infraUp` does, instead of only logging a Docker failure.
  - `staleTokens` throws `WorkspaceError`, and `initWorkspace`'s "not inside a workspace" error is a `WorkspaceError`.
  - `syncRegistry` returns a failing step, instead of throwing, when it can't read the registry or back up a hand-written one; with no backup it leaves the hand-written registry in place.
  - `getClaudeTranscript`, `getClaudeTurnStatus` and `relayPickedUp` are typed `SessionTranscript`, `TurnStatus` and `SessionMessage[]`, and `getClaudeTurnStatus` asks the workspace's own harness.
  - `graduateNote` takes a `Note`.

- 07721e7: `werkmeister pr open`'s YAML-error hint for a PR file now quotes `skip_release: "no release entry: docs only"`, the wording the generated pr-rules use, instead of naming changesets, which a repo without them doesn't have (SW-877).
- 3245798: `werkmeister pr status` and `pr watch` compare an open PR's head with the worktree's branch. When the branch holds commits the PR doesn't (a fixup nobody force-pushed), they warn and print the push command. After merge, the PR file records the PR head as `head_sha:`. While the worktree is still on that branch with commits past it, the PR stays `merged` with a "not shipped yet" line naming `werkmeister pr new`, and its issues don't move to Done (SW-943).

## 0.96.4

### Patch Changes

- 75a6d8c: The `baseline <svc>` row of `werkmeister pr gate` / `pr open` now runs the probe the service's `health_endpoint` names, the same one `feature status` runs on a forward: an HTTP GET for a path (passing below 500), the Redis or Postgres handshake for `redis` / `postgres`, and a TCP connect for `""`. A local datastore service (e.g. `postgres`, `health_endpoint: ""`) now passes the gate instead of failing with `GET http://localhost:<port> → unreachable`, and the row's message names the probe it ran (SW-938).

## 0.96.3

### Patch Changes

- f49540b: Capacity admission no longer lets three kinds of start past the budget. A plain `feature up` beside a running on-demand service prices every `up` service it starts, not its set less what runs. A running feature costs at least what its compose reserves for its running services, so a container started with no or lower limits no longer reads as free. An admitted start is reserved in `~/.werkmeister/scheduler/starting.json` until its containers run (or for 10 minutes), so two admits before either one's containers exist can't both take the same room (SW-907).
- 3d2e1a6: A `werkmeister feature up` of a feature that already runs no longer queues it when the rest of its set doesn't fit: its containers keep running, it exits 75 with "rerun", and its session is not held. Before, the wait wrote `waiting.json` over live containers, and the capacity hook denied every docker, pnpm and node call until a grant re-upped it. The hook's "Waiting for capacity" message now says to confirm with `docker ps` and wait for the grant notice rather than stop (SW-909).
- c0fc52f: Preemption no longer stops a feature whose session shows a tool-permission prompt: that prompt is mid-turn (often for a `docker exec` into the same container), so it ranks like the turn it sits in, working in an autonomous workspace and a person's otherwise. A question or plan prompt still counts as waiting on a person (SW-910).

## 0.96.2

### Patch Changes

- 8ff10d0: SW-890: `werkmeister pr push` leases on the PR head the conflict wake saw, not on `origin/<branch>` as last fetched, so a full `git fetch` after a reviewer's commit can no longer let the force-push drop it. `pr watch` records that head as `conflict_head:` in the PR file beside `notified_conflict`, keeps it until the PR settles or the next conflict wake, and wakes again for a conflict flagged before this release (which has none). `pr push` refuses when it is missing, when origin's branch is no longer it, or when the local branch never held it (its reflog), so a commit pushed to the PR before the conflict isn't dropped by the rebase either; it records the head it pushed. Rule 5 and the conflict wake message say so; after an "origin moved" refusal the agent rebases keeping the new commits and hands the push to the person.

## 0.96.1

## 0.96.0

### Minor Changes

- 03e8bad: SW-828: the six `with-temp-home … node --test*` ask rules are now opt-in (`workspace_ask_rules: true` in `~/.werkmeister/config.yaml`), since they prompted on every core test run even in auto mode. Workspaces drop the recorded ones on their next `feature up` or `machine migrate`. New ask rules cover `docker exec * <ws>/.werkmeister/bin/with-fixture-workspace [--no-wait] --exec-runs*`, which ran with no prompt.

## 0.95.5

## 0.95.4

### Patch Changes

- bdc564c: A whole-feature `werkmeister feature up` of a feature that already runs part of its set is now priced for what it adds, so it waits, preempts or never fits like any other start instead of being admitted over the capacity budget (SW-889).
- 0c65559: A starved queue head that fits only once a person's workspace stops no longer holds every waiter behind it: later starts that fit run past it, and it holds the room again once it can fit without that person stopping (SW-903).

## 0.95.3

### Patch Changes

- 96aa738: `budget status` labels the host-load figure `host load limit N`, since it is the ceiling and not a reading, and adds `(not enforced on macOS)` there (SW-728).
- 27d4ef6: A feature with a `docker exec` running in its containers (a session's test run, not only the gate's) is busy: preemption never picks it and the idle reaper never stops it. `budget status` shows it as `run in flight`. When werkmeister does stop a workspace on its own (preempted, or idle), its session's nudge names each command the stop killed and says to rerun it (SW-856).

  `with-fixture-workspace --running` takes an optional 6th column, the running `docker exec`s, so an exercise can show a busy holder.

- ddc7d5f: The services `pr gate` and `pr open` start now share one 30-minute wait for room in the budget, keeping their queue place, instead of 10 minutes each that ended by dropping the place (SW-869).

## 0.95.2

## 0.95.1

### Patch Changes

- 54c43fa: `with-fixture-workspace --gate` takes `--pr-line '<key>: <value>'` (repeatable), written into the seeded PR file as is, so a test can seed an unquoted value that `--pr-field` would quote, e.g. `--pr-line 'skip_release: no changeset: test-only'`, which the gate refuses with "Quote values that contain a colon". The keys are `--pr-field`'s but `status` (`--pr-field status=` already writes that line as is); one line, and it needs `--gate` (exit 2 otherwise). In-process fixtures take `prLines` (SW-851). Rerun `werkmeister workspace init` to regenerate the script's usage line.

## 0.95.0

### Minor Changes

- 8ce9825: SW-717: `werkmeister pr push [repo]` force-pushes an open PR's rebased branch with `--force-with-lease` on `origin/<branch>`, so a session finishes rule 5's conflict fix without the person. It refuses anything but the workspace's own checked-out branch, a dirty tree, a merge from the base, or a lease origin no longer matches. ICM workspaces pre-approve it; rule 5 and the conflict wake message name it. SDK: `pushPrs`.
- 6b0433e: SW-795: `werkmeister workspace abandon "<reason>"` (and the `close-out` MCP tool with `abandon`) now moves a Jira issue to Done instead of leaving it In Progress, so an abandoned ticket leaves the queue. The comment reads `Abandoned, not shipped: <reason>` and names the branch that holds `postmortem.md`. `--keep-open` (MCP `keep_open`) puts the issue back as To Do instead, for work parked to retry later. Set `issue_statuses.abandoned: null` to keep the old comment-only behaviour.

### Patch Changes

- 51e1348: SW-733: `werkmeister pr gate` fails a branch that holds a merge commit from its base, naming the rebase to run instead, since a rebase merge queue replays only non-merge commits.
- 1c5abaf: SW-827: the generated `issues-report.md` and the postmortem skill tell a run to cite its own files by the workspace record branch plus path (or a permalink), never by the workspace folder, which close-out removes.
- 2eca2ca: SW-874: `workspace init` warns when `work_type` names no template (e.g. `bug`), naming the valid keys, instead of silently using the feature stages.
- 22e16b2: SW-878: an issue fetched from Jira REST now reads as Markdown, not Jira wiki markup, in `.werkmeister/issue.md` and `werkmeister issue view`: `{{code}}` becomes backticks, `\-` escapes are dropped, smart links become Markdown links named by their issue key, and headings, lists, bold and `{code}` blocks are converted.
- 4367479: SW-886: `workspace create` counts a service named in a nested Markdown list item, which it used to drop as an indented log line.

## 0.94.4

### Patch Changes

- 2a8f495: `with-temp-home` takes `--cwd <dir>` (after `--no-wait`) and runs its command there, whatever the shell's cwd; in the werkmeister container the same worktree maps to `/app`. The test commands in `werkmeister-context.md` and their allow rules now pass `--cwd <ws>/<repo>`, so they work from the workspace root too, still with no `cd` (SW-652). Rerun `werkmeister workspace init` to regenerate the file; `werkmeister machine migrate` refreshes the rules and the wrapper.
- 47cd1d8: Tests only: `up_exit.test.ts` drops an inherited `WERKMEISTER_ROOT`, and the `waitForSetupLoad` tests restore `WERKMEISTER_NO_WAIT` (SW-671).
- eb7da8b: `werkmeister internal wait-load` decides exit 75 from the wait's structured result (`spent`, `note`), not by parsing its note (SW-716).
- a0625a5: `with-fixture-workspace --stale-compose` (with `--fragment-change`) inits the workspace before the branch's fragment lands, so `pr gate` starts the service from `compose.gate.yml`; in-process fixtures get `staleCompose` and `applyFragmentChange()` (SW-817).

## 0.94.3

### Patch Changes

- 31dd7fd: Shared infra made from an old checkout path is detected. A container made from another checkout's compose file is named, with `werkmeister infra up` as the fix, by `feature up`, `infra proxy-reload`, `feature status` and `infra status`. `infra up` now recreates those containers too, including one whose only drift is the files it was made from. Caddy counts as unhealthy when its `/__werkmeister` picker page is missing from its mount, which used to 404 on every routed host.
- 879f709: `feature stop --via-daemon` (the SessionEnd auto-stop) calls the daemon even when the CLI can't find its own daemon build for the build header. The lookup failure used to throw before the request, and the error was dropped, so the stop did nothing and exited 0. It now sends no header, and any daemon error other than "not running" is printed.

## 0.94.2

### Patch Changes

- 2896765: Two repos in one workspace that use the same `node_modules_volume` name now get `<repo>-<name>` volumes instead of sharing one; a workspace with one such repo keeps its volume. `clean` recognises the scoped names.
- 444af37: When the branch is behind `origin/<base>`, the `pr gate` base row names the files base changed that the branch also touches, with "rebase, recheck the spec and tests that name them, rerun". The row's pass or fail is unchanged.
- 598dbde: `workspace new` with no free slot prints the next step once: init's "container step did not run" banner is dropped when create called it; the slot warning and the "Workspace created at …" line stay.
- 633fcce: `workspace new` no longer takes services from a command or log quoted in the issue: it ignores code blocks, indented lines and command-shaped `{{…}}`/backtick spans, maps a named code path (`packages/werkmeister-core/src`) to its service, and reads the starting prompt only when the issue names none.
- 4aa1aad: `pr adopt` over an approved PR file that was never opened fills in its url, merge sha and status and keeps its body, instead of writing a follow-up file.
- 2bcf30b: Templates and workspace skills are read from the checkout the code runs from when `WERKMEISTER_ROOT` is only config.yaml's `paths.werkmeister_root` (the value env.sh exports into every shell), so a workspace worktree's build renders its own templates. The daemon, Caddy and shared-infra paths still follow `WERKMEISTER_ROOT`, and any other value still wins everywhere.

## 0.94.1

### Patch Changes

- 03c1389: Generated `.werkmeister/pr-rules.md` no longer names Changesets outside the two places that explain changesets-only behaviour: the release-bot example, the merged-PR release note and the quoted `skip_release` example now say "release entry". The repo-agnostic test now checks every markdown file `workspace init` writes (skills, `_shared/`, `CLAUDE.md`), not only the stage contracts.
- 448cb50: `werkmeister-context.md` § Test commands now prints the test of a container that holds the real `~/.werkmeister` or the docker socket, and mounts the workspace folder at its host path, under the temp HOME: `docker exec -w /app <container> <ws>/.werkmeister/bin/with-temp-home --no-wait sh -c '…'`, as its Validation text requires. Other containers (a docker.sock-only one cannot see `<ws>/.werkmeister/bin`) keep the bare `docker exec` line, and the allow rules are unchanged. Rerun `werkmeister workspace init` to regenerate the file.
- db0280e: The implement stage contracts name one way to serve a static HTML page for a browser check (the Chrome tool refuses `file://`): `python3 -I -u -m http.server 0 -b 127.0.0.1 -d <dir>` as a background job, stopped by its task ID, recorded in `exercise.md` as the method.
- 8223702: The implement stage contracts say the Chrome window does not size below 477 px, and check a narrower width (e.g. 375 px) in a same-origin iframe built with the JS tool: a screenshot plus `scrollWidth === clientWidth` inside the frame.

## 0.94.0

## 0.93.12

### Patch Changes

- 15e1b2a: `generate-certs.sh` now pins its own locale (`LC_ALL=C`; every value it handles is an ASCII hostname), so the certificate step of `machine setup` no longer depends on the caller's locale. When the script fails, it prints the line that failed and its exit code, and setup's step points at that line instead of reporting only the exit code (SW-642).
- a962638: `machine setup` no longer installs the ponytail plugin on every machine. Like superpowers, it is now an optional plugin, and the wizard asks about each optional plugin separately. A machine that already has ponytail keeps it, setup keeps it current, and `machine setup --check` does not report it either way (SW-643).

## 0.93.11

### Patch Changes

- d645d1a: SW-842: `workspace_ask_rules: false` in `~/.werkmeister/config.yaml` turns off the six `node --test` `permissions.ask` rules every workspace's `.claude/settings.json` gets. The `--exec-runs` asks always stay, and the default keeps all of them. With it off, the next `workspace init`, `feature up`, `feature up --service` or `machine migrate` removes the `node --test` asks werkmeister wrote, keeps any added by hand, and writes none back. Only the YAML boolean `false` turns them off, and `machine setup` / `machine config` keep the key. See docs/configuration.md § workspace_ask_rules.

## 0.93.10

## 0.93.9

### Patch Changes

- c547067: Before a run files a bug about a generated file (`.claude/settings.json`, `.werkmeister/*`, `compose.yml`, `.env`) that changed outside its own edits, the review step of every ICM code stage and the issues guide's "Bugs: new or existing?" tell it to compare the file with its record (`claude-permissions.json`), compare its mtime with the session's own activity, and ask the person through the question tool whether they edited it (SW-844).
- e11eb24: The ICM fix and implement stages now run the repo's format command where the service's tests run (its container when its validate text says so), and its registered lint command there before `werkmeister pr gate --tests`, so a one-file fast route no longer leaves a format error for the gate's lint row (SW-846).

## 0.93.8

## 0.93.7

## 0.93.6

### Patch Changes

- 6c653a4: SW-576: a CLI built from an uncommitted tree no longer prints the stale-build notice after an amend that commits exactly that tree. The build stamp also records the dirty tree's id (made in a temp index and object dir: the workspace container mounts the worktree's index read-only, and the build writes nothing to the shared git store), and the notice is silent when HEAD's tree has that id, so `bins.test.ts` stops failing after such an amend.
- 44c12ab: SW-809: `with-fixture-workspace --queue <feature>:<waitedMin>[:<service>,...]` (and `withFixtureWorkspace({ queue })`) seeds a waiter's workspace, compose.yml, lease and `waiting.json`, not only its name, so a starved, whole-feature or service queue head runs through the built CLI. `--queue` now repeats; a bare name still seeds only the name.
- 1e7cf60: SW-835: `werkmeister feature up --service <name>` refreshes the workspace's Claude settings first, as the whole `feature up` already does. A workspace whose `.claude/settings.json` lost rules werkmeister recorded in `.werkmeister/claude-permissions.json` (for example an `ask` block deleted by hand) gets them back on its next `up --service`, and the repaired files are committed on the record branch. It refreshes only the workspace the command runs from, and never inside the feature's own container.

## 0.93.5

## 0.93.4

### Patch Changes

- bf11837: PR rules (SW-661): rule 3's background-job recipe now covers `pr gate` and `pr gate --tests` too (`werkmeister pr gate --tests > <workspace>/.werkmeister/gate-run.log 2>&1`, kept on the record branch with the other `gate-*.log`), and the ICM stage contracts and `pr` help point to it instead of saying "detached", so a full gate no longer gets cut off by a 10-minute foreground tool call.
- c3f8ad3: `pr gate` (SW-724): the fragment and lockfile base lookups, and `--tests`' diff, share one `git merge-base` per gate run instead of running it once each.
- 8c6679c: `pr gate` / `pr open` (SW-734): a service the PR file's `skip_tests` names is no longer started, from `compose.gate.yml` or as the lint/release container, so the gate no longer waits for capacity for it or its install. The lint/release container is another repo service when one exists. The capacity-wait line now says that stopping the command ends the wait, and that the gate starts no `skip_tests` service.
- acd29ef: `pr gate` / `pr open` (SW-739): a test row killed with exit 137 under host load is run once more, after the host-load wait `with-temp-home` uses, and its row says it was retried. It fails only if the retry fails too.
- c0adef6: `pr gate` / `pr open` (SW-744): a test row whose only error is vitest's worker RPC timeout (`Timeout calling "onTaskUpdate"`, a worker blocked past vitest's fixed 60 s under host load) is run once more after the host-load wait, like an exit 137, and its row says it was retried. A real failure beside it (a failed test, a type error) still fails with no retry. The CLI's own tests start the bundled CLI and scripts asynchronously, so they no longer block a worker that long.

## 0.93.3

## 0.93.2

### Patch Changes

- be37df0: Capacity queue (SW-682): a queued feature that can no longer fit the budget (queued before `budget.*` was lowered, or its compose grew) is dropped from the queue during a grant, and its session is told why with the NEVER_FITS message. The waiters behind it still start.
- b559753: Capacity queue (SW-686): containers a `--service` or gate start stopped while it waited for capacity now come back through `docker compose up --wait`, in dependency order and with health conditions, instead of one `docker start` per container by name. If they don't all come back, the error names the containers still stopped.
- 6db2de7: Capacity queue (SW-701): a `feature up --service` start that waits its 10 minutes without room now keeps its queue place instead of leaving it. It still exits 75, but it stays queued with its first wait time; when room frees, the grant pass starts that service, reloads the proxy and tells the session to continue. A rerun keeps its place. A parked start never holds the room against later starts, so a start that can't fit can't stall the queue. Gate starts, and starts that stopped their own containers to wait, don't park.
- 4667dd1: Capacity hook (SW-713): a session is no longer held by "Waiting for capacity" after its feature has left the queue. The hook clears a leftover waiting file instead of denying every tool call, and `feature restart` of a queued feature takes it out of the queue, so its running containers no longer leave the session stuck.
- 35638b3: Capacity queue (SW-737): a queued feature is started when room frees, even with no stop to trigger it. One waiter whose start failed (low memory or host load, a missing compose file) ended the whole grant pass, so every 10-minute `pr watch` tick failed on it and nothing behind it started, on an idle host too. The pass now skips that waiter and keeps it queued. A `--service` or gate start now runs a grant after it starts, and a start that gives up waiting runs one for those still queued.
- e417971: Capacity queue (SW-738): an agent's `feature up` in a person's workspace no longer starts as the person, so it can't stop another workspace's working containers. A start whose preemption fails to stop a container now puts that feature back in the queue to come back, and waits at the head of the queue itself, instead of leaving the other feature down and its own start not started.
- 6d6fb25: Capacity queue (SW-745): a running `pr gate` / `pr open` is never preempted. The gate marked itself busy only when it started a container or ran a row, so a test row longer than `idle_stop_minutes` read as not busy, and a queued start could stop its containers mid-run (exit 137, reported as test failures). The gate now refreshes that mark every minute while it runs. With `idle_stop_minutes: 0` a gate also counts as busy.
- c8669ea: Capacity queue (SW-763): the "waiting for capacity" and exit-75 messages now say what the start needs against what is free in the budget (`this start needs 4 CPUs, 1.0 GiB; free 3 CPUs, 5.8 GiB of the budget's 8 CPUs, 6.8 GiB`), so a request too big for the host reads apart from a busy one and can be retried with `--service`. The wake on an idle host comes from the `pr watch` grant pass, which SW-737 made work.
- b8d3c7b: Capacity hook (SW-768): while a workspace waits for capacity, its session is held only for commands that need containers or the CPUs (`docker`, `pnpm`/`npm`/`node` and other test runners, `with-temp-home`, `feature up`/`restart`, `pr gate`/`pr open`). Edits, reads, git on the record, `werkmeister feature stop` and prompts go through, so a person's approval can still be written and committed while queued. A paused workspace still holds everything.

## 0.93.1

## 0.93.0

### Minor Changes

- b649d26: SW-807: an icm workspace pre-approves the exact `werkmeister issue start` and `issue view` (its own issue) for the whole run, interactive or autonomous. Each stage contract lists its pre-approved commands under `## Pre-approved` and says to edit files with Read, Edit and Write, not a `python3` heredoc.

### Patch Changes

- dcd78ab: SW-807: the two `with-temp-home env WERKMEISTER_ROOT=* node --test` ask rules are written as `… node --test*`. With the old `:*` suffix Claude Code read the other `*` literally, warned at every workspace session start, and never asked. Run `werkmeister machine migrate` (or `workspace init`) to rewrite open workspaces.

## 0.92.2

### Patch Changes

- 77dee8e: SW-808: `werkmeister pr gate` and `pr open` no longer treat a test row as covered when the branch changes that service's container settings. The service starts from `compose.gate.yml` and runs its own row there, so the new settings are tested, whether its cover was declared with `test_covered_by` or detected from `--filter`s.

## 0.92.1

### Patch Changes

- 3fe0672: A repo's `.werkmeister/services.yaml` can list the project's tracker components under `repo.components` (name → what it covers). The fragment schema accepts the key and `registry sync` copies it to `repos.<repo>.components`; no command reads it yet.

## 0.92.0

### Minor Changes

- 06090ba: SW-574: `werkmeister pr gate` and `pr open` no longer start a service's container for a test row another row in the same gate already runs. A service is covered when its registry entry sets `test_covered_by: <service>`, or when its command matches the other row's except for a strict subset of its `--filter`s. The covered row reads `covered by <service>` and passes or fails with that row.

### Patch Changes

- b5f6186: Capacity queue (SW-729): a queued whole-feature head that would fit no longer holds every start behind it. Only another feature stopping starts that head, and room can free without one (a timed-out gate's stop, a Docker restart), so on an idle host starts waited 10 minutes and exited 75 again and again. The exit-75 message now says how long the head has really waited, the same figure `budget status` shows, instead of always "5 min".
- 9661069: SW-736: `04_propose` step 2 now runs the release check after the commit. A check that compares the branch with its base in git history (such as `changeset status --since`) does not see an uncommitted release entry.
- b5dd7d4: SW-771: the person approves the PR file in every run. An autonomous `04_propose` self-check now asks for the approval through the question tool instead of setting `status: approved` itself, and `pr-rules.md` and the stop points say so.
- 4218982: SW-796: a CPU or wall-time number that a decision or acceptance criterion rests on now has to come from paired, alternating A/B runs (at least 3 each) through `with-temp-home` with its load wait on, never a single run or `--no-wait`, with every run's numbers and the host load recorded. The rule is in the feature research stage (step 3) and in every stage that writes `exercise.md`.
- e39e4ef: SW-801: in an autonomous run, a question no option settles (none meets the acceptance criteria, or the issue says to ask the person) stays `status: proposed` and stops the run for the person. The agent never flips a question it has put to the person. The rule is in the stage self-checks and the brief's "Nobody is asked" line.

## 0.91.5

### Patch Changes

- 4ea7192: SW-789: the feature pipeline's research contract (step 3) now tells a gate-, test- or build-speed ticket to sample the container cgroup `cpu.stat` `usage_usec` every 5 s across a cold run and report cores in use per phase before naming a critical path or lever. If the run holds all its CPUs, only a CPU cut shortens it, and the decision says so.

## 0.91.4

### Patch Changes

- 2a3fff3: SW-636: the test commands `werkmeister-context.md` prints, and the allow rules that match them, now run the repo's `lint:` before the test command (`<lint> && <test>`), not after it. A format error now fails within seconds instead of after the full test run: in the werkmeister repo, about 7 s rather than turbo's ~6 minutes. A repo with no `lint:` gets the same lines as before.

## 0.91.3

## 0.91.2

## 0.91.1

### Patch Changes

- eb91a57: SW-754: the hidden `__parse` test hook takes `--batch '<json argv sets>'` and parses every set in one process, one JSON line per set, each on a fresh commander program. `spellings.test.ts` runs its table through one batch instead of one CLI start per spelling: about 24 → 6 CPU-s for the file. `__parse <argv…>` is unchanged.

## 0.91.0

## 0.90.6

### Patch Changes

- fa318f9: Faster starts and prompt exits. `dockerode` (about 300 modules, ~0.2 s of CPU) loads on the first Docker call instead of at start, so a command that never reaches the Engine no longer pays for it. A command that is not installed (a missing `gh`, say) no longer holds the process open for its whole timeout after failing. The MCP proxy exits when its client closes stdin, instead of waiting two seconds to be signalled.

## 0.90.5

### Patch Changes

- c1088f8: The fixture's fake `gh` and `docker` (`with-fixture-workspace`, `withFixtureWorkspace`, `withFakeGh`) are POSIX shell scripts that read their world from plain files, not Node scripts reading `world.json`. A call took ~100 ms to start Node; a fixture flow makes dozens, so the fixture-workspace tests run up to 2x faster. Their output, exit codes and call logs are unchanged.

## 0.90.4

### Patch Changes

- 3edd522: The werkmeister repo's own workspaces get `apps/werkmeister-mcp/scripts/host-daemon.mjs`, named in the `werkmeister-core` validate text: it runs the branch's bundled daemon and CLI on the host, on a temp HOME and a free port (never 3002), with `node_modules` linked to the installed werkmeister's, so a daemon-auth or networking change can be called from a container via `host.docker.internal`.

  The daemon on its loopback bind (`HOST` unset, `127.0.0.1`, `localhost` or `::1`) now accepts a container's `Host: host.docker.internal` header, so a call from a container reaches the token check (401 or 200) instead of the MCP SDK's 403. Browsers are still refused by the Origin check.

- b863c44: The werkmeister repo's install container puts `lsof` in the per-feature tools volume, and the `werkmeister-core` test row no longer installs it with `apt-get`, so the pre-approved test command a workspace's allow rules carry runs no package install on the host.
- 6876b27: `werkmeister-context.md` § How to validate lists a row for every service in the workspace's repos, not only the workspace's own services, since the PR gate tests each service a change reaches. A workspace that runs only `docs-site` now sees `werkmeister-core`'s test command and validate text too.
- d845e3b: `werkmeister-context.md` § How to validate and the ICM reproduce and exercise contracts name the one-off probe form: a `node --test` file run as `.werkmeister/bin/with-temp-home --no-wait node --test <file>`, in the service's container when the host has no node_modules. The workspace's ask rules cover that form (with and without `--no-wait`), so Claude Code asks once instead of the auto-mode classifier denying it; it is still never pre-approved.

## 0.90.3

### Patch Changes

- 4941f67: `with-fixture-workspace` takes `--running <file>` and `--queue <feature>[,<feature>]...`, so a capacity wait runs through the built CLI. Each `--running` line (`feature<TAB>workspace<TAB>startedAt<TAB>memoryBytes<TAB>nanoCpus`) is a container the fixture's fake `docker ps -q` / `docker inspect` show the scheduler as running; the workspace is a folder name created empty in the fixture, so the holder is a person's and never preempted. `--queue` seeds `scheduler/queue.json`. With `--config` `budget: { cpus: 6 }` and a 6-CPU holder, `feature up` exits 75 naming the holder, and `budget status` lists it under Running. `withFixtureWorkspace` takes the same as `containers` and `queue`.
- b61338b: `with-fixture-workspace` and `withFixtureWorkspace` point the dead daemon address (`WERKMEISTER_HOST`) at a port just bound and closed, instead of `127.0.0.1:1`, which fetch rejects as a "bad port" (a TypeError with no `cause.code`) before connecting. A fixture run now sees a refused connection (`ECONNREFUSED`), as with a real stopped daemon, so the refused, restart and fallback paths can be exercised through the fixture.

## 0.90.2

### Patch Changes

- 02a458a: A local-only Caddy host (a service with no `remote_upstream`, such as docs-site) no longer silently serves the first running feature to a request that selects nothing it serves (SW-704). With no `X-Feature` header or cookie it still serves the first feature by name, now marked by an `X-Werkmeister-Served-By: <name> (fallback: no feature selected)` response header. A header or cookie naming no feature that serves the host gets a 404 pointing at `/__werkmeister`. Every feature-routed response names its feature in `X-Werkmeister-Served-By`. Hosts with a `remote_upstream` still default to the tunnel.

## 0.90.1

## 0.90.0

## 0.89.3

### Patch Changes

- 857fbb4: `werkmeister pr gate` and `pr open` no longer test every service when the diff touches `pnpm-lock.yaml`. The gate compares the worktree's lockfile with the one at the diff's base and touches only the services at the `importers:` entries that differ, mapped through `path_mappings` like a file under that importer. The `tests` row says so (`lockfile: pnpm-lock.yaml changes importers <path> → <svc>`). A change to the root importer `.`, to an importer no mapping covers, to an existing `packages:`/`snapshots:` entry, or to a top-level setting (`overrides`, `settings`, …) still tests every service, and so does a lockfile with no copy on the base.

  `with-fixture-workspace` takes `--change-base <file>` and `--change-branch <file>` (with `--change`), which give the changed file real text on main and on the branch, e.g. two lockfile copies.

## 0.89.2

### Patch Changes

- f2a027e: A grant, admission or other daemon call that runs longer than 5 minutes no longer fails with `DAEMON_TIMEOUT` while the daemon is still running it (SW-700). The CLI's `fetch` stops waiting for response headers, or for a silent body, after 300 s, whatever timeout the caller passes. The daemon's `POST /api/tool` now sends headers at once to a client that sends `x-werkmeister-stream: 1`, writes a space every minute, and puts the status in the JSON body. A call that outlasts its own timeout (15 minutes for a grant or admission) is still `DAEMON_TIMEOUT`. Older clients, including an older VS Code extension, still get status codes, and a CLI talking to a daemon that has not restarted yet still works.
- fedb19b: The ICM bug-fix exercise stage (after the review's fixes) and the feature and refactor implement stages (after a fix to the post-exercise review) rerun `werkmeister pr gate --tests` instead of one service's test command. These edits come after the gate's run, and the gate retests every service the diff touches, so a docs fix no longer skips docs-site's tests and fails the first `pr open`.
- 5e724a6: The ICM research and reproduce stages say that when a change adds or widens an input to a pre-approved command (an allow rule, or a wrapper one covers), the decision defaults to an allowlist of accepted values and lists what each can reach (files, env vars, network addresses, processes); a blocklist needs a stated reason.
- b811b93: `werkmeister-context.md` § Test commands prints each running service's `docker exec` test line with the repo's `lint:` appended (`… sh -c '<test> && <lint>'`), as the host test line already does. An implement stage that runs its tests in the container now catches a `docs:check` or format failure there, not first at `werkmeister pr gate`. The lint-tailed line is not pre-approved, since a service container can hold the Docker socket and the real `~/.werkmeister`: Claude Code asks before each run.
- 69877d8: Every ICM stage that exercises a change says that a filter, workaround or special case the exercise needs before the change passes is a finding: a `FAIL` row in `exercise.md` until the code is fixed, or until the row says why it reflects real use rather than a defect.
- 62dca50: The ICM research and reproduce stages name, before a recommended answer or proposed fix is written, how each acceptance criterion's stated verification runs on that design (which command, which platform or container), and turn a criterion whose verification cannot reach the design into an open question.

## 0.89.1

### Patch Changes

- 12dac70: `pr gate` and `pr open` check free memory before they start a container (SW-620). Under `budget.free_memory` percent available (default 15; `0` turns it off) they read `retry later (low memory)` and exit 75 without starting anything, since Claude Code stops an idle background gate when the Mac runs low. `.werkmeister/bin/with-temp-home`'s 90 s wait, and a setup start's, now wait on free memory as well as host load, on macOS too, where memory is read from `kern.memorystatus_level`. A gate whose setup start fails with `HOST_LOAD` is now a retry (exit 75), not a failure.

## 0.89.0

### Minor Changes

- 93442fd: Publish `werkmeister-core` to npm. Its `werkmeister-core/sdk` entry point is the public SDK and follows semver; every other entry point is internal. Versions stay in lockstep with the CLI.

### Patch Changes

- cd975f1: The CLI now waits out the daemon's own restart instead of falling back to in-process scheduling (SW-614). The daemon restarts itself whenever its build changes, and during that gap a call was refused or reset. The CLI now retries for up to 15 s; after one wait gives up, later calls in that process try once. When it does fall back, the warning names the cause: `nothing is listening, the daemon is not running`, `the daemon reset the connection while exiting or restarting`, or `the port is held by something that is not the werkmeister daemon`. A call the daemon accepted but answered late now fails with `DAEMON_TIMEOUT` and is no longer run a second time in the CLI. `werkmeister machine setup --check` now reports a daemon that doesn't answer: on macOS `installed, but nothing answers at <url>: the daemon is not running`, and elsewhere `not on macOS and nothing answers at <url>`.
- 2b4c92b: Caddy now routes a local host by the `X-Feature` request header as well as the `X-Feature` cookie, as `werkmeister-context.md` says. Before, a request with only the header (`curl -H "X-Feature: <feature>"`) reached another workspace's container. When the header and the cookie name different features, the header wins. Run `werkmeister infra proxy-reload` after upgrading to apply it.

## 0.88.2

### Patch Changes

- 3231178: werkmeister-core has a public, fully documented entry point, `werkmeister-core/sdk`, and the Workspaces pane now loads only that. A pane running against a werkmeister older than this release shows `werkmeister-core at <dir> has no ./sdk export; upgrade werkmeister`.

## 0.88.1

### Patch Changes

- 43117b6: A workspace no longer reads "Done" while its turn left a background command running or a capacity wait queued (SW-681). The badge (pane card, VS Code, MCP `status`, check-in) reads Working, and the activity reads `Running in background: pr open` or `Queued for capacity (position N)`. A background shell now ends when Claude Code reports that task's exit, not at the next turn, so a person's or a check-in courier's message no longer clears it.

## 0.88.0

### Minor Changes

- 77b4b48: SW-675, SW-668: a wave of workspaces on a small budget no longer deadlocks on the capacity queue, and capacity waits no longer stop for a person.

  - Backfill: a start that fits goes ahead of a queue head that doesn't. It stops passing once the head is a gate's start or has waited 5 minutes. Gate starts queue ahead of plain `feature up`s.
  - In an autonomous workspace, a `--service` or gate start that has to wait while its feature already runs containers stops them first. Nothing is held while it waits, and it starts them again with the new service. Two gates each holding werkmeister-core no longer wait on each other.
  - A plain `feature up` at the head of the queue may stop idle or waiting-on-a-person features after 5 minutes (`budget.preempt: false` still turns all preemption off).
  - The idle reaper stops a feature whose session has waited on a person's answer for `overrides.idle_stop_minutes`, but only while another feature waits for capacity.
  - Exit 75 means "no capacity yet, rerun": a queued `feature up` (it was 0), a `--service` start that waited 10 minutes (it was 1), and `pr gate` / `pr open` when every failure was a capacity wait (gate reads `retry later (no capacity)`). Scripts that treat any non-zero exit as failure now see a queued `feature up` as one. Each message lists who holds the budget, the head it waits behind, and whether a person is needed.
  - `budget status` lists each running feature's CPUs, memory, session state and running gate, and each waiter's need and wait, in admission order. `--json` adds `running` and `waiters`.

### Patch Changes

- 581a6ed: `with-fixture-workspace --config <file>` adds a YAML file's `budget` section (e.g. `budget.host_load`) to the fixture's config.yaml, so a fixture run can exercise budget and load paths; any other key is refused (SW-670).
- d77b887: `with-fixture-workspace --gate --fragment-change <file>` commits a registry-fragment-only diff, so a fixture `pr gate` shows the `fragment: .werkmeister/services.yaml changes <svc>` row and runs only that service; `--change <path>` names the file `--gate` changes instead of the fixture's default lib file (SW-664).
- dc4c929: `with-fixture-workspace --slots-full` (and `withFixtureWorkspace(fn, { slotsFull: true })`) leases every fixture slot to other features before the werkmeister args run, so a no-slot path such as `workspace init --no-build` runs through the built CLI (SW-634).

## 0.87.3

### Patch Changes

- e370bb4: The npm package is smaller: the CLI, the MCP server and the dashboard now share one copy of their common code instead of each carrying its own. The install's `dist/` drops from about 12 MB to about 7 MB and the download from 4.4 MB to 2.3 MB. Nothing changes in how any command runs.

## 0.87.2

### Patch Changes

- 8a90281: SW-629: a start whose CPUs or memory alone are more than the whole scheduler budget fails at once with `NEVER_FITS`, naming the cost and the budget of the first resource over (`cost 5.0 CPUs > budget 4`) and the fix (raise the engine's CPUs or memory, or `budget.cpus` / `budget.memory` in `~/.werkmeister/config.yaml`, or start fewer services). Before, `feature up` queued it for good and the gate's service starts waited 10 minutes and failed `NO_CAPACITY`, though no preemption could ever make room.
- aa2e36e: SW-649: an autonomous workspace pre-approves the exact frozen install each of its repos' root lockfiles pins (pnpm, npm, yarn v1, yarn berry with `.yarnrc.yml`, uv) instead of always the fixed npm and pnpm pair. The lockfiles are read from the repo's checkout under `repos_root`, not the workspace's worktree, so a lockfile an agent writes grants nothing. A repo with none of these lockfiles gets no install rule.
- 238b387: SW-660: a workspace's allow rules now cover the test command exactly as werkmeister-context.md prints it, the repo's appended lint included. A test command of more than one command (an `&&` chain, a `{ …; }` group, `||`, `;`, a pipe) is printed and allowed as one exact `with-temp-home sh -c '…'` line, so every part runs under the temp HOME and the `{ …; }` rows are no longer a shell syntax error; the bare per-segment rules for the wrapped form are gone. One simple command keeps its `with-temp-home <cmd>:*` rule. `validate:` text still gets no rule. Existing workspaces pick the rules up on refresh or `werkmeister machine migrate`, and the headless wake passes the same list.
- dc871e3: `werkmeister pr gate` and `pr open` now fetch `origin/<base>` before the tests. If a branch that isn't pushed yet is behind it, a `base` row fails and names how many commits behind it is and the `git -C <repo> rebase origin/<base>` to run. No lint or test row runs, and nothing is pushed, so a PR no longer opens conflicting after the gate ran on a stale base. A branch that's already pushed passes with a note pointing at `pr watch` and rule 5's force-with-lease hand-off. The ICM propose stage and `_shared/pr-rules.md` say to rebase before the first push. `with-fixture-workspace --behind` seeds a branch behind `origin/main`.

## 0.87.1

### Patch Changes

- a17418b: SW-631: the daemon refuses a request with no token on every bind, loopback included. Before, a daemon bound to 127.0.0.1 gave machine scope to any request without an `Authorization` header. On OrbStack a container's request to `host.docker.internal` reaches a loopback bind from 127.0.0.1, so any feature container could run any tool on every workspace. The launchd daemon binds 0.0.0.0 and already required the token. The CLI, the plugin's `werkmeister internal mcp`, devcontainers, OpenCode and Codex already send one; a harness registered by hand without a token (Cursor, Copilot, a global `codex mcp add`) must now send the workspace's `.werkmeister/token`.

## 0.87.0

### Minor Changes

- 6f567fb: The workspaces dashboard now ships in the npm package. `werkmeister infra connect` starts it on port 3001 and `werkmeister internal dashboard` runs it in the foreground on an `npm i -g` install, where both previously needed a checkout. The browser form (`werkmeister workspace new --browser-form`) and the Claude Desktop MCP App pages ship too, so a package install no longer falls back to text for them.

### Patch Changes

- ad48946: SW-570: a stage gate at `status: proposed` (a PR file at `status: draft`) is a Needs you item only once the agent has handed it over. While the session is busy, has a background shell running (`Running tests`, or `Running a background shell`), waits on capacity (`Waiting for capacity · position N` once its turn ends) or has containers starting, the /workspaces card, the VS Code tree and check-in show that activity and no Needs you dot. In an autonomous workspace a draft gate never needs the person. A background shell counts until the session's next turn ends, or for 30 minutes.

## 0.86.4

### Patch Changes

- 894957f: SW-630: `feature up`, `feature up --service` and the gate's container starts wait up to 90 s on `budget.host_load` before compose starts a setup service (the install), and say so. If load is still over the limit after that, they fail with `HOST_LOAD` and the load in the message, instead of a 20-minute compose timeout and an install that ends with exit 137. They don't wait on macOS (SW-556: its load average is no signal), when `WERKMEISTER_NO_WAIT=1` is set, or when the gate starts a service `--no-deps` because its install is current.

## 0.86.3

### Patch Changes

- dd1c412: The ICM bug-fix exercise stage collects each manual row's result before the review step, so the review's rerun of `exercise.md` cannot drop a recorded `MANUAL: not run` line.
- 7162800: The ICM research stage checks a recommended answer that rests on an external API, permission or platform behaviour live and read-only before it goes into `decisions.md`; when it cannot, the option text itself says `unverified`, so the person is asked with the word in front of them.
- 5d768ab: The ICM exercise step stops before any browser check when `werkmeister feature up` warns that a routed hostname does not resolve, and asks the person to run `werkmeister machine setup`. It never bypasses a certificate warning; a published-port fallback is recorded in `exercise.md` as a deviation only when the person says to skip setup.
- c06f99d: The ICM exercise stages require each manual-row question to state the URL to open, how to reach this workspace's copy (the `X-Feature` cookie or selector for a routed hostname, or the container's published port), and the visible before → after that means PASS, so the person is not left asking what to look for or checking another workspace's build.
- 44922a4: The ICM build stages (feature implement, bug-fix fix, refactor implement) start by fetching the base and listing the commits on it that touch the files `spec.md`, `repro.md` or `scope.md` changes, plus the status of any ticket a decided question names. A new commit or ticket change that bears on a decision stops the stage for the person before code is written.
- 5030975: The ICM plan stages (feature spec, bug-fix reproduce, refactor scope) say code changes stay uncommitted until the propose stage, so a spec plans the work and its checks, not commits. A grouped PR's contracts say the implement stage makes the per-ticket commits.

## 0.86.2

### Patch Changes

- 953b819: The install setup container puts Claude Code 2.1.316 (CI's pin) in the `tools` volume, so the plugin's `gen-types`, `claude plugin validate` and `claude plugin test` run in the cli and werkmeister-core containers.

## 0.86.1

### Patch Changes

- e8f00dd: `werkmeister pr gate` and `pr open` no longer test every service when the diff touches the repo's own `.werkmeister/services.yaml`. The gate compares the branch's rendered fragment with the one on its base (both through the same registry merge) and touches only the services whose entries differ, so a changed `test:` runs that one service. The `tests` row says so (`fragment: .werkmeister/services.yaml changes <svc>`). A `repo:` key change, or a change to one of the repo's own `setup_services`, still tests every service, and so does a `path_mappings` / `no_service_paths` change that maps a file of the diff differently.
- 7c45de0: `werkmeister infra connect --k8s` help names the shipped compose file by its repo path, `apps/cli/infra/compose/shared-infra.yml`.
- ae543b5: `werkmeister pr gate` and `pr open` run the release check (`release_check`, e.g. `changeset status`) before lint and the test commands. A missing changeset fails the release row in seconds and the tests are not run. A running container gets its setup one-shot re-run first. With nothing running, the check uses the first container the tests would start, so a passing gate starts no extra container, unless that service starts from the branch's own settings (`compose.gate.yml`).

## 0.86.0

### Minor Changes

- c8c721b: A repo can declare `format:` in its `.werkmeister/services.yaml` `repo:` block, e.g. `pnpm exec biome check --write {files}`, `uv run ruff format {files}` or `./gradlew spotlessApply`. `werkmeister-context.md` lists it under "Repo commands", with `release_check` for a `ship: tag` repo. The ICM contracts and the generated `w9r-pr` skill no longer name biome, pnpm or changesets as a managed repo's commands. A repo with no `format:` gets no format step; the gate's `lint` still checks formatting.

## 0.85.7

### Patch Changes

- 9f80deb: Help text and package descriptions no longer cite internal tracker keys (`feature up --service`, `pr`, `migrate`, `tokens`, the github-ingest description), and `feature test` help names only `WERKMEISTER_FEATURE`.
- 841867c: The feature research stage contract now says to check a decision's facts about an external tool (a CLI command or flag, a plugin API, an event name) against the installed tool, not only its docs, and to mark a docs-only fact `unverified: docs only`.

## 0.85.6

### Patch Changes

- ee7e229: `.werkmeister/bin/with-fixture-workspace` now works inside a werkmeister container (`docker exec -w /app <container> <ws>/.werkmeister/bin/with-fixture-workspace …`): it runs the CLI at /app, where the container's node_modules is, instead of the host-path copy that failed `ERR_MODULE_NOT_FOUND: dockerode`. From a host checkout with no node_modules it exits 2 and names that form. Rerun `werkmeister workspace init` to regenerate the script.
- 1f39deb: `with-fixture-workspace --gate --pr-field status=<value>` sets the seeded PR file's `status:` line verbatim (one line, a `# note` included), so a fixture run can check how `pr gate` reads a status form, e.g. `"status=approved  # approved via check-in 2026-11-06"`.

## 0.85.5

### Patch Changes

- bb9398d: `werkmeister workspace abandon --help` has its own text, separate from `workspace close`. Help and error messages that pointed at Users guide sections now name the new Concepts, CLI reference, Configuration and Registry fragments pages.

## 0.85.4

### Patch Changes

- a3e62c4: The implement-side stage contracts (02_fix, 03_implement, refactor 02_implement) now tell the agent, in a repo that uses biome, to run `pnpm exec biome check --write <the files you touched>` before the tests and the commit, so formatting lands in the ticket's own commit (SW-547).

## 0.85.3

### Patch Changes

- 5fd29d0: A crashed session's record now expires (SW-559). After 24 hours with no hook event, a busy record with no pending ask is dropped and its file deleted, so status sweeps stop running the `ps` + `lsof` probe for it and the card stops showing "The session stopped with work unfinished". Idle records and pending questions or permission prompts are kept. Check-in's first run no longer picks a workspace only because a crash loop or notice made it read Needs you. It now picks workspaces with a question, permission, plan or gate waiting, or where Claude spoke last.
- ee0403b: A workspace card no longer reads "Queued for CPU" while only one of its service starts waits for capacity (SW-569). The session keeps working during that wait, so the card shows what it is doing: Running tests, Running Bash, Thinking or Needs you. "Queued for CPU" is now kept for a whole-feature queue, where the session itself is held.
- 531e140: SW-551: when `workspace init` (or `workspace new`) can't get a feature slot, it no longer reports plain success. It warns that the container step did not run and gives the next step: free a slot with `werkmeister feature down <feature>`, then rerun `werkmeister workspace init`. It also writes that notice to `.werkmeister/werkmeister-context.md`, so the agent sees it there too, and the next successful init replaces it with the container recipe. The MCP `init-workspace` tool result now includes `containers`.

## 0.85.2

### Patch Changes

- 2628f5b: Autonomous workspaces no longer pre-approve commands that reach past the workspace (SW-560). They lose `docker exec <feature>-<svc>:*`: every container can reach the host daemon, so a service keeps only its exact registered test in its container. The generic package-manager `run`, `test` and `turbo` rules are gone too, since each registered test and lint segment keeps its own rule. So are the `find`, `sed`, `mkdir`, `ls`, `cat`, `grep`, `head`, `tail`, `diff`, `wc` and `test` rules, which the Glob, Grep, Read and Write tools cover. The lockfile installs are now exact commands. `git -c`, `git config`, `--config`, `--exec-path`, `--template` and `--git-dir` are denied. The threat model in `docs/context-strategies.md` lists what stays open on purpose.

## 0.85.1

### Patch Changes

- eece97b: Jira's "no REST credentials" messages now point to `docs/issue-trackers.md`, which replaces the Jira REST setup page (SW-596). The new Issue trackers page explains what `werkmeister machine setup` asks, then has a section for Jira (API token) and one for GitHub Issues (`gh auth`). In the docs sidebar, "Other harnesses" is now "Harnesses", and the users guide's prerequisites link to it.

## 0.85.0

### Minor Changes

- 5e44780: The daemon can take GitHub events by push (SW-583). A GitHub App's webhook goes to a Lambda function URL that checks the signature and queues the event in SQS. The daemon long-polls the queue and runs one `pr watch` pass for the event's repo within seconds, instead of waiting for the 10-minute schedule. It's off until `~/.werkmeister/config.yaml` has a `github_ingest:` block. Setup: docs/github-ingest.md.

## 0.84.0

### Minor Changes

- e84d3bb: SW-577: every workspace now records an explicit model, picked by tier. `--model` takes a tier (`small`, `mid`, `frontier`, `advanced_frontier`) or an explicit model; blank means `models.default_tier` (frontier). A tier resolves at create/init through `models:` in `~/.werkmeister/config.yaml`, merged over the built-ins (claude: haiku / sonnet / opus / claude-fable-5-1; opencode: the same as `anthropic/…`), and the resolved model goes to workspace.yml and `.claude/settings.json`, so changing the config affects new workspaces only. Codex has no built-ins: set `models.codex.<tier>`, or `workspace new` on a Codex workspace, and `workspace init` in one that records no model yet, fails naming the key. Run `werkmeister machine migrate` once to write the default model into existing workspaces that record none (only `model`: their rules and hooks are left as they are). `werkmeister machine config` prints the tiers; `workspace list` and the workspace card show each workspace's model.

## 0.83.5

### Patch Changes

- e3a5405: SW-543: the bug-fix and incident `01_reproduce` contract now says that when the fix belongs in shared code, call sites are listed through every helper or entry point that reaches it, not one argument shape, and the search commands used are recorded in `repro.md`. New workspaces get the text; an existing one keeps its copy.
- 5af63c1: SW-562: the ICM stages that write `exercise.md` now tell the agent to ask the person for each MANUAL row's result (pass / fail / not run) before asking for approval, and to record it; an approval that skips this keeps the rows MANUAL and the PR file says why. New workspaces get the text.
- 6347d0d: SW-564: the bug-fix and incident `01_reproduce` contract has a new step 7: when the root cause is a permission rule, step 4 lists every source of a matching rule (builders, rules derived from registered commands, rules kept in existing workspaces, a headless wake's tool lists) and the failing test probes each one. The repro file now holds steps 1–7. New workspaces get the text.
- b9dfb3f: SW-565: `pr-rules.md` rule 5 and the `workspace-pr` skill say to take the force-push lease's `<old sha>` from `git rev-parse origin/<branch>` after a fetch and paste it verbatim, never shortened or retyped, for a manual rebase with no wake message to copy from. New workspaces get the text.
- a7464d7: SW-566: the bug-fix and incident `01_reproduce` step 4 now also lists what each caller does with the result (an early return, a printed value, a stored state), so the fix's return shape is checked against every caller before the fix stage. New workspaces get the text.
- fa646c4: SW-568: `pr-rules.md` rule 3 gives the `pr open` log redirect with the absolute workspace path, so a shell cwd that drifted into a code worktree cannot write `pr-open.log` there as an untracked file. The existing `werkmeister pr` allow rule still matches. New workspaces get the text.

## 0.83.4

### Patch Changes

- 0ed217e: SW-546: a service start that does not fit the budget (the pr gate's starts, `pr open`, `feature up --service`) now stops the containers of features whose session is idle or parked on a question, oldest first, instead of waiting 10 min behind them and failing. A person's workspace counts once its session is waiting on a person. The victims are queued as preempted and come back when room frees; the output names each one and why. `budget.preempt: false` turns it off.

## 0.83.3

### Patch Changes

- 421173b: SW-552: a `start <svc>` row the pr gate failed on capacity no longer fails the gate when the gate's later on-demand start of the same service succeeds in the same run; the row reads `started on the second attempt` with the first error. The capacity message has named the workspaces holding the room since SW-540.
- 7f0c186: SW-554: a compose regeneration (`feature up`, the pr gate's `startService`, `workspace init`, the gate's compose.gate.yml) run inside a container now refuses with `INSIDE_CONTAINER` instead of writing the container's `/app` paths into the host-read file, which made the install run an empty script and exit 0. Docker's `/.dockerenv` is the test, so unsetting `WERKMEISTER_FEATURE` no longer gets past it; a relocated `WERKMEISTER_CONFIG_FILE` (every test and fixture) still writes.
- a690187: SW-556: `werkmeister internal wait-load`, the host-load wait `with-temp-home` runs before its command, returns at once on macOS: the macOS load average counts idle daemons (450-550 on a quiet host) and never the Linux VM that runs the tests, so the wrapper waited, or refused with exit 75, while the VM idled. On Linux the 90 s wait is unchanged. `waitForHostLoad` and its unused budget parameters are folded into `waitForHostLoadNow`.
- 4f00d68: SW-563: when a changed file under no `path_mappings` or `no_service_paths` entry makes the pr gate test every service, the passing `tests` row now names it (`every service: no path_mappings or no_service_paths entry for <file>`), so the folder gets mapped instead of starting every container again. The werkmeister repo's own fragment maps `scripts/`, `bin/` and the root licence files to no service (the lint row already runs their checks), and `werkmeister-dashboard`'s `test:` now runs werkmeister-ui's tests too.
- b6eea34: SW-567: the CLI's bins and spellings tests and the MCP proxy test survive a loaded host. Every spawn of the built CLI is async with 180 s of headroom (one starved start took 90-97 s against 60 s), the proxy test's request timeout is explicit instead of the SDK's 60 s default, and a spellings spawn is killed 10 s before the test timeout, so a case can no longer outlive its timeout and write a duplicate snapshot entry that dirtied the worktree.

## 0.83.2

### Patch Changes

- 6716602: SW-545: while a session's own service start waits for capacity (the pr gate's starts, `feature up --service`), the hook no longer blocks the person's prompts or the session's tool calls. The prompt goes through with context naming the queue position, the services and how to stop the wait. A whole-feature queue still holds the session as before.

## 0.83.1

### Patch Changes

- 64e8faa: SW-521: autonomous workspaces no longer pre-approve `node`, `npx`, `pnpm exec` or `python3`, which ran any file (one the agent just wrote included) with the real HOME, and they deny `node` and `python3` outright, so a registered test chain's bare `node --test` segment can't run an arbitrary file either. Headless runs test through the registered `with-temp-home <test command>` and container forms. `werkmeister machine migrate` now refreshes a workspace whose settings still hold a rule werkmeister no longer generates, so existing autonomous workspaces drop the old rules.
- 0c6d2a3: SW-522: the threat model for pre-approved test and CLI rules is written down in `docs/context-strategies.md` and in the generated `werkmeister-context.md`: registered test commands and the workspace's own built CLI may run agent-written code with the real HOME, env, network, docker and gh; the temp HOME is not a sandbox. A test holds the generated rules to it.

## 0.83.0

### Minor Changes

- 6255c49: SW-487: one workspace state model in werkmeister-core. `WorkspaceStatus.workspaceState` gives each workspace a phase, an activity (thinking, running a tool or tests, a background agent, queued for CPU, paused, containers starting, idle, session gone) and a needs-you list. Each item has what, since, action and source: questions, permissions, plans, stage gates, a dead session, run the postmortem, close it, crash loops and system notices, plus CI failed, conflict, changes requested and merge it from `getWorkspacePRs()`. Hooks now keep one record per session (`.werkmeister/sessions/<id>.json`), so sessions and subagents can't overwrite each other's ask, and a crashed session reads as gone after 30 minutes. The /workspaces pane lists every item with its time and action, and check-in reads the same model. Run `werkmeister machine migrate` to add the new Claude Code hook events to existing workspaces.

## 0.82.3

## 0.82.2

### Patch Changes

- ac5a34c: SW-541: the pr gate's service starts no longer re-run `werkmeister-install` when it has already succeeded for the current lockfile and Node major. compose re-ran the exited install on every `up <svc>`, and after a source edit that rebuilt all seven packages at 2 CPUs before the gate's own tests built again. The gate now starts a service with `--no-deps` when every dependency is a setup service whose worktree stamp matches and whose container exited 0, and admission stops pricing that install. `feature up`, with or without `--service`, still re-runs the install, so a service started after a pull gets a fresh build. The shared turbo cache was not at fault: it restores 6 of 7 tasks on unchanged source; low counts came from edits between starts.
- ce48d70: SW-542: `pr gate` and `pr open` no longer wait on host load before lint, each test and the release check. The 1-minute load counted the gate's own install and test rows (an idle 12-core Mac read 36–60 after its own rows, and in the hundreds during a macOS stall with every container idle), so a gate on an idle host waited 1.5–5 min on load it caused. The services a gate starts are already admitted against the budget (SW-540). `--no-wait` is still accepted and does nothing; `with-temp-home`'s own 90 s wait and the host-load line on a failed row are unchanged.

## 0.82.1

## 0.82.0

## 0.81.1

### Patch Changes

- 532983f: SW-526: the generated ICM contracts' test step gives the background log pattern without a trailing `echo "exit $?"` (read the exit code from the job's completion notice) and keeps the echo for a foreground call.
- 97cb3b8: SW-527: `pr open` writes `pr open: exit <code>` as its last line, so a bare `pr open > pr-open.log` keeps the result.
- 7689f33: SW-534: the implement-stage contract (feature and refactor) reruns the code review on the delta when the exercise changes code, and appends the result to review.md.
- c04d525: SW-535: the 04_propose contract tells the agent to file each follow-up that decisions.md promises, and write its issue key there, before writing the PR file.

## 0.81.0

### Minor Changes

- 4822338: SW-509: the fixture has a GitHub project for `o/<repo>#N` refs, so a seeded issue resolves to the fake gh. `with-fixture-workspace --issue o/app#1` (or `withFixtureWorkspace(fn, { issue })`, or `issue_id` / `group:` in a `--workspace` file) shows `issue start`, `pr open`, `pr status` and `workspace close` moves (`gh issue edit` / `close` / `comment`, for the lead and each member) in `--- gh calls`. Jira keys still resolve to Jira.

### Patch Changes

- 18eafad: SW-480: PR rule 6 (merge is the person's act) now makes an exception for a PR the repo's own automation queues, such as a release bot's version PR, so agents stop telling the person it's theirs to merge.
- 315ea0c: SW-483: `workspace init` writes `.devcontainer/devcontainer.json` only on a `harness: claude` workspace. On `mcp`, `codex` and `opencode` it writes none (the generated one installs and registers Claude Code only) and removes one it generated before; a hand-written file is kept.
- 3ef569b: SW-511: the fixture's fake docker logs a gate `exec` as `exec <container> <row command>`, not the whole argv with the inlined `with-temp-home` script, so `--- docker calls` shows which lint or test command ran.
- 8f25967: SW-520: every git call werkmeister makes drops `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` inherited from a calling git (a `rebase --exec` step, a hook), so `git -C <dir>` acts on `<dir>` and not on the caller's repo. This covers `run`/`runAsync`, `runCapture` and every child started with `childEnv()` (handoff commit and push included), the `with-fixture-workspace` fixture, and the stale-build check. The test runners clear the same variables, so a suite started from `rebase --exec` can no longer re-init the real repo.

## 0.80.1

### Patch Changes

- 486fae1: SW-540: the scheduler now admits on-demand service starts. Starting a service (the pr gate's starts, `feature up --service`) asks for that service's CPUs and memory, plus the install it depends on, measured against what Docker shows running. When it doesn't fit, the start waits in the queue with its position on the card ("waiting for capacity"), checks every 15 s for up to 10 min, then fails with `NO_CAPACITY` naming what holds the room. It never preempts another workspace. A queue entry whose poll stopped for 60 s is dropped. `with-temp-home` now exits 75 without running its command when host load is still over `budget.host_load` after its 90 s wait.

## 0.80.0

### Minor Changes

- 24ae868: SW-385: `harness: opencode` (checked on OpenCode 2.2.5). `workspace init --harness opencode` writes AGENTS.md, `.agents/skills`, a plugin in `.opencode/plugins/werkmeister.js` that runs the standards gate, PR guard and agent state, and `opencode.json` with the werkmeister MCP server (scoped by the workspace token) and shell deny rules for shared infra, other workspaces, global installs and `gh pr merge`. Session tools (`claude-send`, transcripts, the Workspaces pane) drive OpenCode over `opencode run` and `opencode session list` / `export`. Session-start context and auto-stop do not run on OpenCode.

## 0.79.4

### Patch Changes

- 0c8ab20: A `pr watch` wake write that fails (disk full, permissions) no longer loses a wake already held for the session: the held wake is put back and the error still surfaces. (SW-502)

## 0.79.3

### Patch Changes

- fdc8418: SW-500, SW-501, SW-515: the ICM first-stage contract and `w9r-research` now say to run `werkmeister issue start` alone, as its own Bash call, so its allow rule matches. If that call is denied anyway, the agent records the denial, stops and tells the person. When the CLI reads stale, the agent tells the person to apply the printed fix and never runs it itself. `pr-rules` rule 3 runs `werkmeister pr open > .werkmeister/pr-open.log 2>&1` alone. The autonomous run limits allow `issue start`'s status move as well as `pr open`'s. In a grouped workspace every automatic issue move now covers the issue and each `group:` member: In Progress, In Review, Done and abandon. The grouped propose contract checks each member reads Done instead of closing it by hand.
- 9e36c19: SW-510: a workspace's Claude settings no longer pre-approve `with-temp-home env WERKMEISTER_ROOT=* node --test:*` or its `--no-wait` twin, because `node --test <file>` runs any file, including one the agent just wrote. Both forms are now `ask` rules, and `machine migrate` moves them in existing workspaces. Tests run without a prompt through the registered test commands (`with-temp-home <test command>`), and the generated `werkmeister-context.md` now says so.
- 4e4fc2a: `werkmeister pr status` now marks a merged PR that sets `skip_release` as shipped (`release: none`) on the first run when its diff has no `.changeset/*.md` and the repo's `release_check` is changesets'. Before this, a test-only PR waited for a release tag until `release: none` was set by hand. A PR with a changeset still waits for its tag (SW-514). `with-fixture-workspace` gains `--pr-field <key>=<value>` to add front matter to the seeded PR file.

## 0.79.2

### Patch Changes

- b5aa231: SW-464: `with-fixture-workspace --workspace <file>` (and `withFixtureWorkspace(fn, { workspace })`) merges a YAML mapping into the fixture's workspace.yml, e.g. `group`, `work_type`, `context_strategy`. Under `context_strategy: icm`, the `--gate` preset writes its PR file, exercise.md and review.md where the icm strategy reads them, so a grouped icm fixture passes `pr gate` with no hand edits.
- 0ff080d: SW-466, SW-497, SW-467, SW-479, SW-465, SW-468: grouped ICM contracts tell the agent to regenerate a changed generated snapshot (e.g. `strategy-jit.snapshot.json`) inside each ticket's commit, and that commit order across tickets is free (the grouped 02_spec no longer fixes it). The grouped refactor 01_scope lists its steps under each ticket key. Every build stage's review brief rates a finding that can restart or write the host daemon, the real `~/.werkmeister` or another workspace as Must fix. `--group` keys are normalised by the tracker's `parseRef`, and the lead's own key is dropped (a lead-only list writes `group: []`). The `--work-type` help says it selects the ICM stages, and the `workspace init --group` help says "one PR, one commit per ticket".
- c40c1a9: `with-temp-home` waits at most 90 s for host load (was 10 min), so an agent's foreground call no longer times out before its command starts; `pr gate` keeps its 10 min budget (SW-469).
- 97b0b89: SW-473: `with-fixture-workspace --exec-runs` (and `withFixtureWorkspace(fn, { execRuns: true })`) makes the fixture's fake docker run each `docker exec` command with `sh -c` in the fixture's code repo and return its exit code, so a fixture `pr gate` passes or fails on the registry's `lint` and a service's `test:`. Without it the fake still logs each exec and answers 0. `--exec-runs` must come first, and a workspace's Claude settings get `ask` rules for it (beside the wrapper's allow rule), because it runs the registry's rows on the host; `machine migrate` adds them to existing workspaces. The fixture also blanks `GITHUB_TOKEN`.
- c21edc6: SW-482: the fixture's fake gh answers `gh pr view`, and `with-fixture-workspace --merged` (or `withFixtureWorkspace(fn, { merged: true })`) makes it report the PR merged, so a fixture run goes `workspace init → pr open → pr status → workspace close` with exit 0.
- 4a0a958: SW-488: Resume's open-session guard matches the workspace's harness, so in a `harness: codex` workspace an open interactive `codex` gets a pending "continue" instead of a headless `codex exec resume` beside it.
- d68fa02: SW-489: `pr watch`'s wake finds the folder a session started in through the workspace's harness, so a `harness: codex` session started in a code worktree records `session_cwd` at `pr open` and is resumed from there, not from the workspace root.
- e644b9c: PR rules and gate fixes (SW-494 group):

  - SW-494: a `pr watch` conflict wake tells the session to rebase onto `origin/<base>` (never merge it in), to take the base's copy of a conflicting generated file and regenerate it, and prints the person's `git -C <worktree> push --force-with-lease=<branch>:<old sha>` filled in; `pr-rules.md` rule 5 says the same.
  - SW-493: a chat reply of "continue" counts as approval, beside "decided", "approved" and "proceed".
  - SW-116: `pr-rules.md` says `pr open` runs the gate itself, so `pr gate` is only for checking without opening.
  - SW-155: the PR file's acceptance table takes `MANUAL` for a criterion only the reviewer can check; the gate passes it and lists it.
  - SW-119: a registry `test: none` (or `test: "none: <reason>"`) marks a service with no tests; the gate reports it skipped with the reason.
  - SW-490: `pr gate` fails while a decided question in `decisions.md` promises a follow-up and names no issue key.

## 0.79.1

### Patch Changes

- 5794317: SW-450: the pre-PR gate names the services a diff left untested (`tests: not touched, not run: …`), and a repo fragment's `repo:` block takes `path_mappings` for paths no service owns, so the werkmeister repo no longer tests all five services for a change under `apps/werkmeister-mcp`, `plugins`, `.github`, `.vscode` or `.claude`.

## 0.79.0

### Minor Changes

- e033938: SW-384: Codex sessions. A `harness: codex` workspace reads its sessions from `~/.codex/sessions`: the pane and dashboard show Working / Needs you / Done and the transcript, `claude-send` runs `codex exec [resume <id>]`, `claude-resume` and the pane's Continue / New Session open `codex`, and usage reads Codex's token counts. Machine-level asks (Jira fallback, refine) and PR reconcile stay on Claude.

### Patch Changes

- 3f75faa: New `werkmeister machine tokens` lists the daemon tokens in `~/.werkmeister/tokens` that have no workspace folder; `--remove` deletes them (SW-446). Before SW-433 (0.74.0), core tests left tokens there named `create-copy-ws-*`, `jit-snap-ws-*`, `record-init-*`, `switch-init-ws*`, `init-registry-*`, `init-branch-fragment-*`, `mcp-ws-*`, `create-default-*` and `create-origin-*`; run `werkmeister machine tokens --remove` once to clear them.
- 2cce430: SW-455: the generated approval text (ICM contracts, the router's one rule, `pr-rules.md`, the `w9r-pr` skill) no longer accepts a relay "only through check-in", a channel the receiving session cannot see. `/check-in` now marks the file it flips with `(approved via check-in YYYY-MM-DD)`, and that note is the approval. A peer message that claims approval while the file is unchanged, or that comes with a flipped status and no check-in note, is refused: the agent leaves the file as found and asks the person.

  Graduation now also offers a decision whose status line carries an approval note (`status: decided (approved via check-in …)` or `(approved in chat …)`); before, the note hid it.

- 3484a52: SW-463: a `pr watch` wake held for an open but idle Claude session now reaches it without anyone typing. Workspace status rows list `heldWakes` (the sessions with a `wake-nudge-<id>.json`), and the werkmeister plugin's band submits one short prompt when its own session has one, no turn is running and Desktop's wrap_up box isn't waiting. The prompt's UserPromptSubmit hook then delivers and claims the wake as before.

## 0.78.0

### Minor Changes

- a376e19: `pr open`: a `hold: <reason>` field in the PR file opens the PR as a draft, with `Don't merge until: <reason>` at the top of its body, so a PR that waits for a step outside the code can't be merged early. Run `gh pr ready <url>` once the step is done (SW-461).

## 0.77.0

### Minor Changes

- d16406b: SW-189: `harness: codex` — a Codex CLI workspace gets werkmeister's hooks in `.codex/hooks.json` (the standards gate reads `apply_patch` paths, PermissionRequest marks needs-you, the pause gate denies without `continue: false`) and the werkmeister MCP server in `.codex/config.toml` with `default_tools_approval_mode = "approve"` and `tool_timeout_sec = 1800`.

## 0.76.1

### Patch Changes

- e96afd6: A wake `pr watch` holds for an open session is now kept in `.werkmeister/wake-nudge-<session>.json`, and the hook claims it by renaming the file before reading it. Two hooks firing at once no longer both deliver it, and a message `pr watch` adds during delivery is no longer dropped (SW-444). A wake still held in the old `wake-nudge.json` at upgrade is not delivered.
- 24cb424: `pr watch` now wakes the session when an open PR's merge-queue run fails. GitHub drops the PR from the queue while its head checks stay green, so the check rollup never showed it; the wake names `merge queue (<workflow>)` and quotes the failing run's log (SW-454).

## 0.76.0

### Minor Changes

- 63769dd: SW-445: an unknown word after `workspace` or `ws` now fails with `unknown command` and creates nothing. The deprecated `workspace <feature>` form, due for removal in 0.58.0, is gone: use `workspace new <feature>`.
- 9b3acaf: A grouped PR (SW-438) no longer needs a hand edit of `workspace.yml`: `werkmeister workspace new` and `werkmeister workspace init` take `--group <member keys>`, the create form (terminal wizard, browser form, Desktop pane and its `workspaces_pane_fill_create_form` tool) has a **Grouped PR members** field, the `init-workspace` MCP tool takes `group`, and the plugin's next-wave skill folds a triage group into its lead and creates the lead's workspace with `--group`. `WERKMEISTER_GROUP` still works (SW-459).

### Patch Changes

- c160d18: SW-451: `werkmeister issue create --relates` refuses a value that is not exactly one issue key (`SW-29x`, `SW-292,SW-263`) before anything is filed. Only the key's format is checked, not that the issue exists.
- 71b7749: SW-456: killing the generated `with-temp-home` while it waits for host load now ends its `werkmeister internal wait-load` too, instead of leaving it polling for up to 10 min. The generated werkmeister-context.md says that a `with-temp-home` call with no output and only `wait-load` under it is that wait, not a hang, and that `--no-wait` skips it. A workspace gets the new wrapper and text the next time `werkmeister workspace init` runs in it.
- 9c03ab6: SW-462: pr-rules rule 6 says a merge queue's method decides how every PR merges; a PR that needs another method says so and the person bypasses the queue. Grouped with SW-457 (rule 6's grouped exception; `pr gate` warns when a grouped PR's base won't rebase-merge), SW-448 (the no-file-change approval sentence covers peer messages outside check-in only), SW-458 (a chat approval in a PR file is a YAML comment on the status line), SW-449 (the review step fixes a Should fix that shows the change's own text is false), SW-442 (reproduce lists each condition that makes a fix's predicate true), SW-460 (a grouped refactor takes each ticket's scope steps, then commits) and SW-453 (the postmortem's review.md search stays out of the code worktrees).

## 0.75.0

### Minor Changes

- 9ab8223: A workspace can mark itself as a grouped PR with `group: [<member keys>]` in `.werkmeister/workspace.yml`. Its ICM build stages then commit once per ticket and review the range `origin/main...HEAD`, and `propose` keeps the per-ticket commits, asks for rebase and merge, and closes each member after the release (SW-438). The same release: implement stages review before `pr gate --tests` (SW-430), the review brief asks what a newly pre-approved command can reach (SW-431), the first stage's brief rule names no werkmeister files (SW-414), and propose's lint step reads "when it has one" (SW-415).

### Patch Changes

- 8eb783e: SW-410: `pr open` retries a push that GitHub refuses with an SSH auth or connection error (twice, 10 s then 30 s apart), and a push that still fails points at githubstatus.com. When `issue start` can't fetch, its `Worktree:` line says to re-check with `werkmeister issue start`, and the first stage contract (and the w9r-research skill) now re-runs it before going on instead of continuing unchecked. Rule 3 in the generated `_shared/pr-rules.md` runs `pr open` as a harness-tracked background job instead of `nohup … &`.
- c08f22a: SW-436: `issue start`'s stale-CLI fix now reads `git -C <checkout> pull --ff-only origin main`, which works under `pull.rebase=true`. When the origin fetch fails, the `CLI:` line says it could not check, names the fetch error and how to re-check, instead of `currency not checked`.
- 5a04db0: SW-437: every `pr open` run that opens a PR prints one `pr watch:` line: scheduled (where, and its log), or NOT scheduled with `werkmeister pr watch --install`, so a session knows whether a failing check or a conflict will wake it.

## 0.74.0

### Minor Changes

- 149111d: SW-432: `werkmeister issue create --relates <key>` (repeatable) links the new issue "relates to" each key after creating it and prints each link. Every key is checked before anything is filed; a link Jira refuses still prints the new key, then exits 1. The generated `issues-report.md` shows the flag and, in a workspace with an issue, says to pass it for a follow-up.

### Patch Changes

- 7090ac2: SW-353: the generated approval text (ICM contracts, the router's one rule, `pr-rules.md`, the `w9r-pr` skill) now says a message from another session that only says to re-read an output file is not the approval: the file's `decided` or `approved` status is, so the agent acts on it without asking the person again. A message that claims approval with no file change is still not accepted, and a relay that exists only in a message still counts only through check-in.
- 9dbbbbc: `pr watch` now reaches a session that is still open. A wake it holds for a busy terminal session (a conflict, a failed check, a review, a merge) is claimed and handed to that session's hooks: it arrives as context on the session's next prompt or tool call, or blocks its next Stop. It is never sent headless as well, and the workspace card stays `needs-you` until the session gets it (SW-418).
- b5b092c: Under `WERKMEISTER_FIXTURE` (`with-fixture-workspace`, core fixture tests) `claude` and `kubectl` are stubs that fail loudly, like `gh`, unless `CLAUDE_BIN` names a claude; and the caller's `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `KUBECONFIG` and `GH_TOKEN` are blanked for each fixture step (SW-424).
- b5b092c: `WERKMEISTER_NO_WAIT=1` now skips the `pr gate` / `pr open` host-load wait too, not only `with-temp-home`'s; `with-temp-home --no-wait` exports it, so `with-fixture-workspace --no-wait … --then pr gate` runs without a load wait (SW-425). Regenerate a workspace's wrapper with `werkmeister workspace init`.
- b5b092c: `with-fixture-workspace` gains `--fragment <file>` (so `registry sync` runs under the fixture) and `--daemon` (a fake daemon that logs each call); without `--daemon` the daemon address is dead even when the shell exports the real one. `--gate` with a `--services` registry that has no `lib` now exits 2 instead of seeding a change no service maps to. Core tests get `withFakeDaemon` (SW-426).
- b5b092c: Core tests run outside `with-temp-home` (a bare `node --test`, an editor's test runner) no longer write workspace tokens and locks into the real `~/.werkmeister`: `withSandboxHome` now points HOME at its temp home (SW-433). On a machine that ran them, delete the leftovers with `rm ~/.werkmeister/tokens/create-copy-ws-*`; no real workspace has that name.

## 0.73.0

### Minor Changes

- a74391c: New generated `.werkmeister/bin/with-fixture-workspace`: one command seeds a temp fixture workspace (registry, a code repo with a local bare origin, logging fakes for gh and docker, dead Docker, daemon and Jira addresses), runs this workspace's built CLI against it (`--then` chains steps, `--print` shows files, `--gate` adds a ready PR) and removes it. Core tests get the same fixture from `withFixtureWorkspace` (SW-292).

### Patch Changes

- a74391c: `pr open` under `WERKMEISTER_FIXTURE=1` pushes only to a local origin and otherwise prints `push skipped (fixture)`, so an end-to-end fixture run can open a PR with no write to GitHub (SW-381).

## 0.72.1

### Patch Changes

- 8b09898: `pr gate` and `pr open` no longer wait for host load on a diff that touches no service (docs only, `no_service_paths`): lint and the release check run at once, since no test suite runs (SW-303).
- 8b09898: The pr gate's lint, test and release commands now run inside the container through the `with-temp-home` script (inline, with `--no-wait`), so a gate test run can no longer read or write the real `~/.werkmeister` the container mounts (SW-329).
- 8b09898: `with-temp-home` now unsets `CLAUDECODE` and every `CLAUDE_CODE_*` variable (keeping `CLAUDE_BIN`) before running its command, so a test or exercise run from an agent's shell matches a clean shell or CI. Run `werkmeister machine migrate` to refresh an existing workspace's wrapper (SW-332).
- 8b09898: `pr gate` and `pr open` now check the worktree is clean together with the other quick rows (stages, acceptance, approved, repo, exercise, review) and stop there when any fails, before lint and the tests start containers or wait for host load (SW-364).
- 8b09898: `.werkmeister/bin/with-temp-home --no-wait <cmd>` skips the host-load wait without an env assignment, so the agent keeps its one permission rule; the generated allow rules and werkmeister-context.md cover the flag. `WERKMEISTER_NO_WAIT=1` still works. Run `werkmeister machine migrate` to refresh an existing workspace's wrapper and rules (SW-367).
- 8b09898: The gate's acceptance, exercise and review rows now name the table (its heading) and the row that holds a FAIL or a non-PASS result, and the 04_propose contract says every `result` cell in the PR file must be `PASS`, with a pre-fix reproduction in prose (SW-390).
- 8b09898: `pr open`'s record commit force-adds the paths it names, so a workspace created before SW-401 (whose `.gitignore` still ignores `gate-*.log`) gets its "record opened PR(s)" commit with the PR file and logs instead of failing on the ignored pathspec (SW-407).
- 8b09898: `pr gate` and `pr open` check push access first (`git push --dry-run origin <branch>`): with no access they fail within seconds with a ✗ push row naming the git error and how to fix it, and run no lint or tests (SW-408).

## 0.72.0

### Minor Changes

- 7660ca9: `werkmeister internal mcp`, the MCP server the werkmeister plugin and Claude Desktop start per session, is now a thin stdio proxy to the host daemon. Tool calls run in the daemon, which restarts itself on a new build, and the proxy sends `tools/list_changed` when it does, so a rebuild or upgrade reaches every running session without a `/mcp` reconnect (SW-344).

  **This upgrade needs one `/mcp` reconnect or session restart**, as will any later change to the proxy itself (release notes will say). The daemon must be running: `werkmeister machine setup` (macOS) or `werkmeister infra connect`. When it is down, a tool call says so instead of running old code.

### Patch Changes

- 7660ca9: `claude-resume` and `pr-reconcile` open a VS Code terminal when called from the Claude Code VS Code extension, which sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode` and no `TERM_PROGRAM`; before, they opened Terminal.app (SW-409).

## 0.71.3

### Patch Changes

- 178fba3: Docs: fix stale sample output and "What it does" steps in the status, up, services, connect, test and down help pages and man pages; drop the "formerly sandbox" rename history from the READMEs; `docs:gen` marks UI-only MCP tools from each registration's own `_meta`; changeset README and `npm pack` prepack notes.

## 0.71.2

### Patch Changes

- 86741d7: The ICM spec stage asks how an existing user turns the change on (the setup or config path and its doc, or none needed), and maps the answer to an acceptance criterion (SW-111).
- 86741d7: ICM test steps and the `fix.md` / `exercise.md` they write name every skipped test with its skip reason and where it ran instead (workspace container, gate or CI) (SW-125).
- 86741d7: The ICM research stage greps tests and fixtures for the exact value a change alters and lists the hits, instead of asserting that no test covers it (SW-242).
- 86741d7: The first ICM stage says what to do when the root cause lies outside the brief's stated scope: record it, carry on with the smallest change that reaches it, and list it first under Recommendations for reviewer (SW-275).
- 86741d7: The ICM spec stage names every active standards row, loads the ones whose Applies-when matches a file the spec changes, and lists each ticket-vs-standard conflict under `## Conflicts` in `spec.md` (SW-288).
- 86741d7: The ICM test step shows the log redirect wrapping the whole `&&` test chain (`{ <test command>; } > <log> 2>&1; echo "exit $?"`), so the turbo output no longer spills into the tool result (SW-334).
- c438582: SW-342: a workspace created from an issue now takes `services:` from the service names the issue spells out (within the chosen repos), so a plain `feature up` starts them. When nothing is local, `feature up` names the on-demand services and prints `start one with: werkmeister feature up --service <name>`, and the generated `werkmeister-context.md` How to validate says the same.
- 86741d7: Every ICM template's first stage now starts by writing `## Goal`, `## Acceptance criteria` and `## Open questions` into `BRIEF.md` from the issue (or the starting prompt) when the brief has no criteria yet, so later stages and self-checks have a list to walk (SW-345).
- 86741d7: ICM build stages (bugfix fix, feature and refactor implement) read `git diff` in each touched repo and tick off each settled edit before running the tests, so an edit that never reached the file is caught (SW-351).
- 86741d7: The ICM research stage greps the tests for whole-module mocks (e.g. `vi.mock("<module>"`, `mock.module`) of each module the change adds an export to, and lists every hit as a fixture to update (SW-365).
- 86741d7: When the first ICM stage writes the brief's acceptance criteria, a change to generated text is checked by a fixture run of the built generator; regenerating the workspace's own file is a post-release check (SW-374).
- 86741d7: The ICM reproduce stage judges each repro run by its exit code, or by a check shown to fail on a known-bad run, never by grepping test output (SW-392).
- 86741d7: The ICM propose stage runs the repo's lint command after adding the release entry and before committing, so a bad changeset fails there instead of at `werkmeister pr open` (SW-399).
- 86741d7: The bug template in `_shared/issues-report.md` keeps **Actual** and **Evidence** for what was observed, with each statement marked observed or inferred, and sends inferred causes to **Suspected cause** (SW-400).

## 0.71.1

### Patch Changes

- ed5e14c: `pr gate` with a paused container now fails with a clear ✗ "paused: press ▶ Resume on its card, then rerun" row instead of a lint/test failure from `docker exec`, and no longer ticks the paused container as running (SW-391).
- ed5e14c: Resume no longer runs a headless `claude -p --resume` beside an open interactive session: a headless turn's `SessionEnd` can't erase the open session's live record, and Resume checks for an interactive `claude` running in the workspace before it goes headless, leaving the "continue" nudge for it instead (SW-397).

## 0.71.0

### Minor Changes

- 057962d: SW-388: ICM feature and refactor implement stages, and the bugfix/incident exercise stage, end with a code review step. A fresh subagent runs `ponytail:ponytail-review` over each code worktree's uncommitted diff, every Must fix is fixed in place, and the stage writes `output/review.md` with a PASS/FAIL row per worktree. The bugfix/incident exercise stage now loads the coding standards, since the review may change code there. The PR gate has a new `review` check: it fails when `review.md` is missing or has a row that is not `PASS`, and `skip_review: <reason>` in the PR file skips it. Existing workspaces are unaffected: the gate asks for a review only when a stage's `CONTEXT.md` names `review.md`, which happens once `werkmeister workspace init` re-renders the contracts (init rewrites every stage contract).

## 0.70.2

### Patch Changes

- d99e9ea: SW-319: the plugin's install check (`skills/install-check/check.sh --fix`) brings a stale `dist` up to date after a `main` pull. It runs `corepack pnpm install --frozen-lockfile`, then `corepack pnpm turbo run build --filter=werkmeister`, so core is rebuilt before the CLI bundles it. It prints `FIX` only when the rebuild succeeds; a failed rebuild prints the first error lines and no longer refuses the next prompt of every session.
- beeaab4: `workspace create` no longer doubles the issue slug when the feature name already starts with it (SW-370).
- 924600e: `werkmeister workspace close`, refusing a workspace with a merged PR, now says that a PR which ships no release needs `release: none` in its PR file. The PR rules and docs say a change that ships nothing sets `release: none` beside `skip_release`; `skip_release` alone still waits for a release tag in a `ship: tag` repo (SW-393).
- d9ef46e: `werkmeister workspace close` names the `release: none` fix only for a merged PR that set `skip_release`, so a PR waiting for its release tag is no longer told to skip it. `werkmeister pr status` says `merge commit unknown` when a merged PR file has no `merge_sha`, instead of a garbled line (SW-393).
- beeaab4: Generated allow rules now cover the stage test commands run through `with-temp-home` (each `&&` segment, for every service of the workspace's repos) and the `env WERKMEISTER_ROOT=… node --test` fixture form, and werkmeister-context.md names those rules; headless sessions are no longer refused (SW-398).
- beeaab4: The workspace record keeps the gate and pr-open logs: `.gitignore` no longer ignores `gate-*.log` and `pr open` commits them with `pr-open.log` (SW-401). Existing workspaces keep their old ignore line.

## 0.70.1

### Patch Changes

- a44dd23: Harness interface: `HarnessAdapter`'s session types are harness-neutral and the detached turn runner is shared across harnesses (SW-383). No user-visible change.

## 0.70.0

### Minor Changes

- dd6aed2: Revert SW-309: agents no longer ask through Markdown forms, and /workspaces cards no longer show the `❓ <file> · N open` line or the Answer sheet. ICM stages go back to their earlier gate files, `decisions.md` goes back to its earlier format, and werkmeister-core drops `parseForm`, `applyAnswers`, `formErrors`, `submitForm` and `openForms`. A replacement is tracked in Jira.

### Patch Changes

- c4263c6: The `werkmeister-install` one-shot runs `pnpm install --frozen-lockfile` on every run instead of skipping while the lockfile stamps match: pnpm's own up-to-date check takes seconds and restores a package missing under the `node_modules` volume, which the stamps cannot see; the npm path keeps the stamp skip (SW-362). The PR gate runs that one-shot once for a container it keeps: `compose up` of a running service leaves it as is and re-runs the exited setup, so a kept container's rows run on a checked volume. Its `containers` row reads `kept (… already running, setup one-shot re-run)`.

## 0.69.0

### Minor Changes

- 2a72809: The Claude adapter's `ask` helpers (starting-prompt refine, issue distillation, the Jira Atlassian-MCP fallback) run through the Agent SDK with structured output instead of scraping `claude -p`'s stdout: a failed run names the SDK's result subtype. `@anthropic-ai/claude-agent-sdk` is a required dependency of `werkmeister` again (SW-386).

## 0.68.0

### Minor Changes

- 9368784: `werkmeister registry sync --from <worktree> --out <file>` merges that checkout's `.werkmeister/services.yaml` in place of its repo's fragment and writes the registry to `<file>`, so a fragment change can be proven inside the workspace before merge. `~/.werkmeister` is left untouched; `--check` works against `--out` too (SW-281).

### Patch Changes

- 2d51f5d: SW-361: the CLI bundle (`werkmeister#build`) is no longer turbo-cached. Its build stamp (HEAD plus the dirty flag) is not a turbo input, so a build cached from an uncommitted tree replayed after the commit with a stale stamp, and the PR gate's `bins.test.ts` failed on the stale-build notice. The bundle rebuilds in under a second on every run.
- 8b10ce8: SW-363: a branch-built CLI run on the host (a test without `with-temp-home`, a worktree's `machine config` or `machine setup`) no longer writes its own worktree into `~/.werkmeister/config.yaml` and `env.sh` as `werkmeister_root`. The writers keep the stored value and warn unless the running checkout is the `werkmeister` on PATH; to move it by hand, edit `config.yaml` and run `werkmeister machine config --write`.
- ab6d40a: `workspace close` passes a clean code worktree left on a detached HEAD after the merge (its branch deleted, no untracked files, nothing missing from origin's default branch) with "nothing to hand off" instead of refusing with "no branch to push (detached HEAD)" (SW-372). A detached worktree that is dirty or holds a commit not on origin still refuses, and the message now says why.

## 0.67.0

### Minor Changes

- b0496a9: SW-188: a generic MCP adapter. `werkmeister workspace new --harness mcp` (config `harness`, env `WERKMEISTER_HARNESS`) generates a workspace for any agent harness with MCP and skills: `AGENTS.md` instead of `CLAUDE.md`, skills in `.agents/skills`, no subagents, and hooks reported as unavailable (`hooks: unavailable on mcp …` at init and `up`, the `hooks` MCP tool's new `hooks` field, a note in `AGENTS.md`) rather than silently missing. The harness connects to the host daemon at `http://127.0.0.1:3002/mcp`; `docs/harnesses.md` says how for Codex CLI, Cursor and Copilot CLI.
- 06a3f28: SW-195: `claude-resume` and `pr-reconcile` open a VS Code integrated terminal when the caller runs in VS Code (`TERM_PROGRAM=vscode`, or `WERKMEISTER_LAUNCHER=vscode|terminal` to force either), through the extension's new `vscode://jbbz.werkmeister-vscode/claude?workspace=…&mode=…&session=…&prompt=…` URI handler; Terminal.app elsewhere, as before. `claude-resume` takes an optional `prompt` sent as the session's first message, and both tools report which `launcher` opened.

## 0.66.3

## 0.66.2

### Patch Changes

- adf5e2a: The generated `.werkmeister/werkmeister-context.md` now marks each host whose service has a `feature_router` with no remote upstream as answering only while a feature runs that service (in Quick Health Checks and Proxy Routing), and tells the reader to check `~/.werkmeister/infra/proxy/features.json` before reading a TLS reset (curl exit 35) with a healthy `w9r-caddy` as an outage.
- 99e3380: `werkmeister pr gate` now prints `✓ containers: skipped (<container> already running)` when a running feature container means it skips starting a service, instead of omitting the row.

## 0.66.1

### Patch Changes

- c5b8878: `werkmeister feature up` and `workspace init` now render a workspace's `compose.yml` with each of its repos' own `.werkmeister/services.yaml` fragment merged over the global registry, the way the pre-PR gate already tests a branch. A branch that changes a service's `command:`, image, setup or volumes runs that change in its feature containers before merge; other repos' services still come from the registry, which is left untouched (SW-337).

## 0.66.0

### Minor Changes

- 2da3414: SW-341: `werkmeister feature up` (including `--service`) and `werkmeister infra proxy-reload` now resolve every routed hostname after regenerating the Caddyfile and warn about any that does not resolve to 127.0.0.1 on this machine, printing the exact `echo "127.0.0.1 <hosts>" | sudo tee -a /etc/hosts` line and pointing at `werkmeister machine setup`. The command still succeeds.

### Patch Changes

- 1f1894f: SW-357: `feature restart` help says a registry or `services.yaml` change needs `feature up`, not restart.
- d543024: Machine config writes (`werkmeister machine config --write`, `machine setup`, `machine migrate`) refuse inside a workspace container with `INSIDE_CONTAINER`: the container's HOME is the host home and `~/.werkmeister` is bind-mounted, so a write there pinned the host's `werkmeister_root` and `env.sh` to the container's `/app/apps/cli` (SW-354). A config relocated with `WERKMEISTER_CONFIG_FILE` is still written. The `setup_run_pending` test, which did the writing from the PR gate's container, now stubs the writers.
- a2a7db3: `werkmeister feature up` commits the `.claude/settings.json` and `.werkmeister/claude-permissions.json` it rewrites on the record branch (`chore: refresh Claude settings`), the way `workspace create` commits them, instead of leaving them uncommitted when a werkmeister upgrade added a permission rule since the workspace was inited.

## 0.65.0

### Minor Changes

- 7fa111c: `werkmeister pr status` (and the PR watch pass) now notices a merged PR that changes its repo's `.werkmeister/services.yaml` fragment. By default it prints `registry sync needed: <repo> fragment changed in <url>` and shows it on the workspace card. With `sync_on_merge: auto` in the fragment's `repo:` (or in `services.local.yaml` under `repos.<repo>`), it fast-forwards the clean source checkout, runs `registry sync`, prints what changed and names the running features to bring up again with `werkmeister feature up`.

### Patch Changes

- 5c4353f: SW-338: `werkmeister feature up --service <svc>` now regenerates the Caddyfile and reloads Caddy after the service starts, so the feature cookie reaches this workspace's container instead of falling through to another workspace's upstream.

## 0.64.2

### Patch Changes

- 3c8f294: SW-336: `werkmeister pr gate` (and `--tests`) runs each touched service's test in that service's own container, starting it on demand with its setup service, whatever its `type`. Before, a touched `web` service's test ran in whichever sibling container was running or started (e.g. an `api` service's), with the wrong image and `node_modules`. Lint and the release check still use any one container of the repo.

## 0.64.1

### Patch Changes

- d1f17bc: A workspace whose worktree is the werkmeister repo now pre-approves the built CLI run through its temp-HOME wrapper (`Bash(<workspace>/.werkmeister/bin/with-temp-home <worktree>/apps/cli/werkmeister:*)`), so the auto-mode classifier no longer refuses a CLI-level exercise. The bare wrapper is still never allowed. Existing workspaces pick the rule up with `werkmeister machine migrate`.
- 3223e06: SW-343: `machine setup` without a TTY (or with `--yes`) now reports the skipped CA trust and /etc/hosts as ⚠ with the command to finish, and ends with "Setup incomplete" instead of "Machine is set up."

## 0.64.0

### Minor Changes

- a34b387: A repo can carry its own standards in `<repo>/.werkmeister/standards/`, laid out like the global standards tree. A workspace that checks out the repo loads them on top of `overrides.standards_dir`, and they are active there without an archetype naming them (`standards_override.remove` still drops one). Their generated `w9r-*-standard` skills link to the repo they came from. `werkmeister standards check` also validates every repo tree under `paths.repos_root` and fails when a repo module reuses a global module's `domain`; the global one wins at load time. `checkStandards()` returns the repo trees it checked as `repoTrees`, and `loadStandardsModules` takes the workspace's repo paths as a second argument.

### Patch Changes

- 90c30e8: SW-335: `werkmeister machine detect` names the shared install's `node_modules_volume` `<repo>-node-modules` instead of `node-modules`, so two repos in one workspace no longer share one install volume (an existing fragment's name is kept on a re-run). With a lockfile, the install command is npm's clean install or `pnpm install --frozen-lockfile`, so an up can't rewrite it. New docs page: docs/repo-setup.md, on setting up a repo for Werkmeister.

## 0.63.0

### Minor Changes

- 7b92579: `werkmeister pr gate --tests` runs the gate's lint and test rows in the workspace container on the uncommitted tree; the implement stage runs it so container-only failures show before `pr open` (SW-316).

## 0.62.1

### Patch Changes

- 63f4d97: SW-324: `werkmeister issue view` prints the whole description instead of cutting it at 4000 characters without a sign. Where the cap still applies (the briefing that refine and the form pre-fill feed to a model), the text now ends with `[cut: N more characters not shown]`. `issueBriefing` takes an optional `{ full: true }`.

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

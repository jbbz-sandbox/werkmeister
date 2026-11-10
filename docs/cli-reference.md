# CLI reference

Every command runs as `werkmeister` (or `w9r`), which `pnpm link --global` (run in `apps/cli`) or a global install puts on your PATH; from a bare checkout use the `apps/cli/werkmeister` wrapper script. The examples below use `werkmeister`. Run `werkmeister --help` for a list of commands, or `werkmeister <command> --help` for one command's help.

Every command and option, grouped as `werkmeister --help` groups them. Each command's text below comes from its `apps/cli/src/commands/<command>.help.md`, which its `--help` also prints; `pnpm run docs:gen` writes this section, so edit the help.md, not this page.

## Commands

<!-- generated:cli-reference -->

### Features

#### werkmeister feature up

Detect services, allocate slot, generate config, start containers

`werkmeister feature up [feature]`

- `-w, --workspace <path>`: Path to directory containing repo checkouts. Default: ~/workspace (override with paths.workspaces_root in ~/.werkmeister/config.yaml).
- `--dev`: Run the file watchers in cli/library/extension containers, which otherwise idle.
- `--service <name>`: Start only this service and wait for it, the way the PR gate does — including one behind the on-demand profile. `feature stop` stops it.

The local services come from the workspace's `.werkmeister/workspace.yml` (via `werkmeister workspace init`), not from a flag.

**What it does:**

1. Loads the service registry and port configuration, and stops with a clear message if a secret one of the workspace's services needs is missing
2. Resolves the workspace (`--workspace`, else `paths.workspaces_root` from the config, else the nearest enclosing repo's parent, else `~/workspace/`) and reads its local services from the `SERVICES=` line `werkmeister workspace init` wrote to the workspace `.env`
3. Allocates a slot (1–12) if the feature doesn't already have one
4. When the workspace has local services, checks the host's memory and CPU budget (`werkmeister budget status`). If the feature doesn't fit it waits in a queue and starts when another feature stops. A service start that doesn't fit may instead stop features whose session is idle or waiting on a person, oldest first, and says which; a feature a person starts may also stop working autonomous ones (`budget.preempt: false` turns both off)
5. Generates per-feature files in the feature's workspace:
   - `compose.yml` — Docker Compose stack definition (workspace root)
   - `.env` — Environment variables with resolved service URLs (workspace root)
   - `<workspace>/.werkmeister/supergraph-config.yml` — GraphQL federation config (only when a service has a GraphQL type: `graphql-subgraph`, `graphql`, `subgraph` or `federation`)
6. Verifies k8s port-forwards are healthy (restarts if needed), only when a local service needs the cluster
7. Starts containers with `docker compose up -d --build --remove-orphans`
8. Regenerates `~/.werkmeister/infra/proxy/Caddyfile` and reloads Caddy (or starts it, when something here is routed)
9. Warns about routed hostnames that do not resolve to 127.0.0.1 on this machine and prints the `/etc/hosts` line to add (the command still succeeds)

**Output example:**

```
=== werkmeister up: my-feature ===

[info] Loading configuration...
[ok]   Allocated slot 1 for 'my-feature'

  Local services: backend, frontend

[info] Checking k8s port-forwards...
[info] Starting containers...
[info] Configuring reverse proxy...

=== Feature 'my-feature' is ready ===

  URL:     https://frontend.local.werkmeister.io
  Cookie:  X-Feature=my-feature
  Slot:    1 (ports 11100-11119)

  Local services:
    * backend -> localhost:11100
    * frontend -> localhost:11101

  k8s services: (everything not listed above)

  Useful commands:
    werkmeister feature status            # view all features
    werkmeister feature logs my-feature    # tail logs
    werkmeister feature test my-feature    # run Playwright tests
    werkmeister feature down my-feature    # tear down
```

**If the workspace lists no services**, the command still proceeds — the feature is registered and routes entirely to k8s. To add services later, list them in `.werkmeister/workspace.yml`, rerun `werkmeister workspace init`, then `werkmeister feature up`.

**If the feature has to wait for capacity**, the command exits successfully without starting containers and prints `=== Feature '<name>' is waiting for capacity (position N) ===`. `werkmeister feature status` shows the queue.

**If every slot is taken** (12 by default, `feature_slots.count`), the command exits with an error. Free a slot by running `werkmeister feature down` on another feature.

**`--service <name>`** starts only that one service, the way the PR gate starts it, and prints `Started <feature>-<name>`.

**Adding a service to a running feature.** To run another service locally, add it to the `services` field in the workspace's `.werkmeister/workspace.yml`, rerun `werkmeister workspace init` (this also adds the owning repo's worktree if it isn't there yet), then `werkmeister feature up`.

#### werkmeister feature down

Stop containers, release slot, update proxy (`infra <verb>` for shared infra)

`werkmeister feature down [feature]`

- `-v, --volumes`: Also remove Docker volumes (node_modules, caches)
- `--all-features`: Stop and clean up all active features (ignores \<feature> argument)

**What it does:**

1. Leaves any k8s intercepts the feature holds (best effort; teardown never waits on Telepresence)
2. Stops all Docker containers for the feature (`docker compose down --remove-orphans`)
3. Releases the slot back to the pool, and clears any pause or capacity wait
4. Starts queued features that now fit in the freed budget
5. Regenerates the Caddyfile (removing this feature's routing rules) and reloads Caddy if running

The feature's generated files (`compose.yml`, `.env`, `.werkmeister/`) are left in place in its workspace — they're overwritten on the next `werkmeister feature up`.

By default, per-feature Docker volumes (node_modules, build caches) are preserved so the next `werkmeister feature up` is faster. Use `--volumes` to remove them for a full cleanup.

The command is safe to run even if the feature is already stopped — it will clean up any leftover state.

#### werkmeister feature restart

Restart containers (`infra <verb>` for shared infra)

`werkmeister feature restart [feature]`

Useful after making code changes that hot-reload doesn't pick up. If the feature doesn't have a slot, prints an error suggesting `werkmeister feature up` instead. A changed registry or `services.yaml` definition (e.g. a new `command:`) is not applied by restart, which keeps the existing `compose.yml`; run `werkmeister feature up <feature>` instead.

#### werkmeister feature pause

Freeze a workspace's running containers and hold its Claude session until resume

`werkmeister feature pause [feature]`

Freezes a workspace's running containers and holds its Claude session until `werkmeister feature resume`. Nothing is removed: the slot, the containers and their state stay as they are.

**Examples**

```bash
werkmeister feature pause my-feature
werkmeister feature resume my-feature
```

#### werkmeister feature resume

Thaw exactly the containers pause froze, release the session, and tell it to continue

`werkmeister feature resume [feature]`

Thaws exactly the containers `werkmeister feature pause` froze, releases the Claude session, and tells it to continue if the pause cut a turn short.

**Examples**

```bash
werkmeister feature resume my-feature
```

#### werkmeister feature services

List services and their endpoints for a feature

`werkmeister feature services <feature>`

Shows each service of a running feature with its source and endpoint:

```
=== Services for: my-feature ===

  Service                    Source    Endpoint                        Type           
  ──────────────────────────────────────────────────────────────────────────────────
  backend                    k8s      localhost:9052                  api
  frontend                   local    localhost:11101                 web
  search                     baseline  localhost:11102                 api

  local = running in Docker on this machine  |  baseline = services.yaml baseline_upstream  |  k8s = port-forwarded from k8s cluster
```

`Source` is `local` for a container running on this machine, `baseline` for the `baseline_upstream` named in `services.yaml`, `k8s` for a port-forward from the cluster, and `N/A` when the service has no endpoint (`(not configured)`). If the feature isn't running, the command says so and prints `werkmeister feature up <feature>` instead of failing.

#### werkmeister feature logs

Tail a feature's container logs

`werkmeister feature logs <feature> [service]`

Streams logs in real-time (equivalent to `docker compose logs -f --tail 100`). Press `Ctrl+C` to stop.

```bash
# All services
werkmeister feature logs my-feature

# Just frontend
werkmeister feature logs my-feature frontend
```

#### werkmeister feature drop

Stop a local service, fall back to k8s

`werkmeister feature drop <feature> <service>`

Removes the service from the feature's local stack. The service will now be served from k8s. Config files are regenerated and Caddy is reloaded.

If removing the last service, the feature's containers are fully stopped (though the slot remains allocated — use `werkmeister feature down` to release it).

```bash
werkmeister feature drop my-feature frontend
```

#### werkmeister feature test

Run Playwright tests against a feature's stack

`werkmeister feature test <feature> [extra...]`

- `--scaffold`: Don't run: write playwright.config.ts + \<feature>.spec.ts into the workspace (if missing) and install the pinned @playwright/test
- `-w, --workspace <path>`: --scaffold: workspace directory (default: from cwd)
- `--base-url <url>`: --scaffold: ingress URL to target (default: the first feature_router service)

**What it does:**

1. Looks for a `playwright.config.ts` (or `.js`/`.mjs`) in the workspace root, then in each repo worktree under it (`~/workspace/<feature>/<repo>/`). There is no fallback to the Werkmeister root.
2. If none is found, runs nothing and exits non-zero. The message lists each workspace service's test command and `validate:` guidance. Libraries, CLIs and extensions are validated that way, not with Playwright; see [Test commands and validation guidance](registry-fragments.md#test-commands-and-validation-guidance).
3. Otherwise sets `WERKMEISTER_FEATURE` and, when the feature has a slot, `WERKMEISTER_SLOT` for the Playwright process and runs `npx playwright test` from that directory with a 10-minute timeout

```bash
# Run all tests
werkmeister feature test my-feature

# Run specific test file
werkmeister feature test my-feature -- tests/homepage.spec.ts

# Run with headed browser
werkmeister feature test my-feature -- --headed
```

The feature doesn't need to have an active slot — if it doesn't, the command warns but proceeds with just the feature header routing.

**`--scaffold`** writes a starter `playwright.config.ts` and spec into the workspace and installs the pinned Playwright, without running anything. It refuses a feature name that already has a slot.

#### werkmeister feature open

Open a feature-tagged Chrome window with the X-Feature cookie set (no Playwright)

`werkmeister feature open [feature]`

- `--url <url>`: Full start URL (overrides --path). Default: the first routed host's homepage.
- `--path <path>`: Path appended to the first routed host (default: test_path from .werkmeister/workspace.yml, else TEST_PATH from .env, else '/').
- `--size <W,H>`: Window size WIDTH,HEIGHT (default: 1440,900).
- `--position <X,Y>`: Window position X,Y (default: staggered by feature name).

Launches an isolated Chrome window for a feature: it sets the `X-Feature` routing cookie and tags the window (title prefix and corner badge) so it is plainly that feature's window. It drives Chrome over the DevTools Protocol, without Playwright.

Routing only resolves while the feature is running (`werkmeister feature up`). Otherwise the cookie is set but traffic falls through to the k8s baseline.

**Examples**

```bash
werkmeister feature open my-feature
werkmeister feature open my-feature --path /settings
werkmeister feature open my-feature --size 1280,800 --position 0,0
```

#### werkmeister feature stop

Stop containers without removing them or releasing the slot

`werkmeister feature stop [feature]`

Stops a feature's containers without removing them or releasing its slot. Bring it back with `werkmeister feature restart` or `werkmeister feature up`. Use `infra` as the feature name to stop the shared infrastructure.

Two modes run without a person: `--if-idle` is the SessionEnd hook behind a workspace's `auto_stop`, and `--idle` is one pass of the idle reaper over every workspace.

**Examples**

```bash
werkmeister feature stop my-feature
werkmeister infra stop
werkmeister internal reap 30
```

**See also**

`werkmeister feature down` also releases the slot; `werkmeister feature pause` freezes the containers instead.

#### werkmeister feature status

Show all features, services, resource usage

`werkmeister feature status`

- `-v, --verbose`: Show individual container details
- `--intercepts`: Show Telepresence intercept state only (per feature service; cheap — skips docker and k8s probes).
- `--json`: Output structured JSON (useful for agent-driven diagnosis)

Shows shared infrastructure, every active feature and the k8s port-forwards in one view.

**Output example:**

```
=== Werkmeister Status ===

  Infrastructure
  Service                    Status
  ────────────────────────────────────────
  caddy                      healthy
  k8s-forwards               healthy
  mcp-web-server             healthy

  Features
  Host load 1.8 2.1 2.0 (10 cores)  |  feature containers 14% CPU
  Slot  Feature                    Services                             Ports            Status
  ───────────────────────────────────────────────────────────────────────────────────────────────
     1  my-feature                 backend, frontend                    11100-11119      up (2/2)  12.3% CPU · 410 MiB · started 2 h ago by up
     3  other-feature              frontend                             11300-11319      partial (0/1)

  k8s Port-Forwards
  Service                    Ports              Health check                  Status
  ─────────────────────────────────────────────────────────────────────────────────────
  redis                      :9050 → :6379      (tcp)                         alive
  postgres                   :9051 → :5432      (tcp)                         alive
  backend                    :9052 → :80        /health                       alive
  frontend                   :9053 → :8080      /                             dead

  2 active feature(s), 10 slot(s) available  |  k8s: 3/4 alive

  To restart dead forwards: docker restart w9r-k8s-forwards
```

**Status indicators:**
- `up (N/M)` (green) — all containers running
- `partial (N/M)` (yellow) — some containers running
- `paused (0/M)` (cyan) — every container paused
- `down (0/M)` (red) — no containers running
- `no containers` (dim) — compose file exists but no containers found

A feature's row ends with its CPU and memory and how long ago it started, when known. A container that keeps restarting adds a red `✗ <service> crash-looping (N restarts)` line under it; `--verbose` lists each container. Features waiting for a slot show as `Waiting for capacity: <feature> (#1)`.

**`werkmeister infra status`** shows only the k8s port-forwards (`feature status --k8s` is deprecated). Each forward is one row: the listen port on this machine mapped to the remote port, the health check (`(tcp)` or an HTTP path) and `alive`, `dead` or `unknown`:

```
=== k8s Port-Forward Status ===

  k8s Port-Forwards
  Service                    Ports              Health check                  Status
  ─────────────────────────────────────────────────────────────────────────────────────
  redis                      :9050 → :6379      (tcp)                         alive
  postgres                   :9051 → :5432      (tcp)                         alive
  backend                    :9052 → :80        /health                       alive
  frontend                   :9053 → :8080      /                             dead

  3/4 services alive

  To restart dead forwards: docker restart w9r-k8s-forwards
```

When the forwards container is not running, it says so instead of listing rows: `not running` (start it with `werkmeister infra connect`), `container w9r-k8s-forwards is down`, or `stopped — not needed by any running workspace`.

### Workspaces

#### werkmeister workspace prompt

Print the enclosing workspace's starting_prompt from workspace.yml

`werkmeister workspace prompt`

- `--start <dir>`: Directory to search up from (default: cwd)
- `--args`: Print the start_session arguments (title, model, prompt, background) as JSON instead

Prints the enclosing workspace's `starting_prompt`, for the starting-prompt skill.

**Exit codes**

1 when no `workspace.yml` is found walking up from `--start`; 2 when it has no `starting_prompt`.

#### werkmeister workspace new

Create a new workspace under $WERKMEISTER_WORKSPACES_ROOT (git worktrees on a \<user>/\<workspace> branch) and run init-workspace inside it.

`werkmeister workspace new [feature]`

- `--issue-id <ref>`: Issue ID in this machine's issue tracker (see `werkmeister machine setup`). Its slug is prefixed to the workspace dir name; passed through to init-workspace.
- `--project <name>`: The project (projects: in ~/.werkmeister/config.yaml) whose tracker holds the issue. Default: the one whose scope holds --issue-id, else the default project.
- `-s, --services <list>`: Comma-separated services to run locally. Their owning repos are added as worktrees, and the list is passed through to init-workspace.
- `-r, --repos <list>`: Comma-separated repos to create worktrees for (union with the repos derived from --services). Interactive multi-select if neither --repos nor --services is given.
- `--labels <list>`: Comma-separated free-form tags for filtering workspaces in the dashboard search; passed through to init-workspace.
- `--group <keys>`: Comma-separated member issue keys of a grouped PR led by --issue-id (one PR, one commit per ticket); passed through to init-workspace.
- `-t, --task <title>`: Task title for the workspace CLAUDE.md; passed through to init-workspace.
- `--test-path <path>`: URL path for feature testing; passed through to init-workspace.
- `--description <text>`: Free-form description for the CLAUDE.md header; passed through to init-workspace.
- `--starting-prompt <text>`: First instruction for the agent; passed through to init-workspace.
- `--work-type <type>`: Kind of work; selects the ICM stages and seeds the JIT first-phase handoff note. Passed through to init-workspace.
- `--context-strategy <id>`: Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). (env: WERKMEISTER_CONTEXT_STRATEGY; config: context_strategy).
- `--harness <id>`: Agent harness that reads the workspace: claude (CLAUDE.md, .claude/, hooks), mcp (AGENTS.md, .agents/skills, no hooks), codex (AGENTS.md, .agents/skills, .codex/hooks.json, .codex/config.toml) or opencode (AGENTS.md, .agents/skills, opencode.json, hooks plugin) (env: WERKMEISTER_HARNESS; config: harness).
- `--autonomous`: Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a headless session needs (env: WERKMEISTER_AUTONOMOUS; config: autonomous).
- `--model <tier|model>`: Model tier (small, mid, frontier, advanced_frontier) or an explicit model; blank = models.default_tier in ~/.werkmeister/config.yaml (frontier) (env: WERKMEISTER_MODEL; config: model).
- `--auto-stop`: Stop this workspace's feature containers when a Claude session in it ends and no other is open (a SessionEnd hook; env: WERKMEISTER_AUTO_STOP; config: auto_stop).
- `--browser-form`: Collect inputs through the Werkmeister-branded browser form (the same form the Desktop MCP App renders), pre-filled from every flag given, then create the workspace. Opens a localhost page in the default browser and blocks until submit/cancel.
- `--no-distill`: Store the issue but don't have a model rewrite it into description/starting_prompt.
- `--open`: With --browser-form: launch VS Code on the new workspace after creating.
- `--force`: Delete a \<user>/\<workspace> branch an earlier workspace of the same name left on origin, instead of aborting (that branch's work is gone; see the abort message for how to continue it instead).

Creates a new workspace under the workspaces root and initializes it. It resolves its inputs (flags, an existing `workspace.yml`, or the interactive wizard), creates the workspace folder as a git worktree of the workspace record repo (`overrides.workspace_repo`) on a `user/workspace` branch, writes `.werkmeister/workspace.yml`, and runs `werkmeister workspace init` inside it. The initial state is committed, not pushed.

**Examples**

```bash
werkmeister workspace new my-feature --issue-id SW-180 --services backend,frontend
werkmeister workspace new my-feature --context-strategy icm --work-type refactor
```

**See also**

`werkmeister workspace init` owns everything derived from `workspace.yml`; `werkmeister workspace close` ends a workspace.

#### werkmeister workspace list

List the workspaces under the workspaces root with their issue and labels

`werkmeister workspace list`

Lists the workspaces under the workspaces root with their issue and labels. The dashboard and the MCP server list workspaces the same way.

**Examples**

```bash
werkmeister workspace list
```

#### werkmeister workspace code

Open a workspace in VS Code

`werkmeister workspace code [feature]`

Opens a workspace in VS Code. The dashboard's `open-workspace` tool does the same lookup and launch.

**Examples**

```bash
werkmeister workspace code my-feature
```

#### werkmeister workspace init

Reconcile a workspace from .werkmeister/workspace.yml: create/remove repo worktrees to match the `repos`/`services` fields, then (re)generate CLAUDE.md / .env / compose.yml. Idempotent — edit workspace.yml and rerun. Inputs resolve as CLI flag > env (WERKMEISTER_*) > workspace.yml.

`werkmeister workspace init`

- `-t, --task <title>`: Task description / title (env: WERKMEISTER_TASK; config: task).
- `--feature <name>`: Feature name for workspace slot routing (config: feature).
- `--services <list>`: Comma-separated list of local services (env: WERKMEISTER_SERVICES; config: services). Their owning repos are added to the reconciled worktree set.
- `-r, --repos <list>`: Comma-separated repos to keep as git worktrees (union with the repos owning --services). Persisted to workspace.yml; the worktree set is reconciled to match on every run (env: WERKMEISTER_REPOS; config: repos).
- `--force`: When reconciling, delete repo worktrees dropped from workspace.yml even if they have uncommitted changes, and delete a \<user>/\<workspace> branch an earlier workspace left on origin instead of aborting (default: abort without changes).
- `--no-build`: Write compose.yml and the context files but skip the image build (`docker compose up --build --no-start`), so no docker call is made.
- `--issue-id <ref>`: Issue ID in this machine's issue tracker (see `werkmeister machine setup`) (env: WERKMEISTER_ISSUE_ID; config: issue_id).
- `--project <name>`: The project (projects: in ~/.werkmeister/config.yaml) whose tracker holds the issue (env: WERKMEISTER_PROJECT; config: project).
- `--labels <list>`: Comma-separated free-form tags for filtering workspaces in the dashboard search (env: WERKMEISTER_LABELS; config: labels).
- `--group <keys>`: Comma-separated member issue keys of a grouped PR led by issue_id: one PR, one commit per ticket (env: WERKMEISTER_GROUP; config: group).
- `--test-path <path>`: URL path for feature testing (env: WERKMEISTER_TEST_PATH; config: test_path).
- `--description <text>`: Free-form description for the CLAUDE.md header (env: WERKMEISTER_DESCRIPTION; config: description).
- `--starting-prompt <text>`: First instruction for the agent; persisted to .werkmeister/workspace.yml (env: WERKMEISTER_STARTING_PROMPT; config: starting_prompt).
- `--work-type <type>`: Kind of work; selects the ICM stages and seeds the JIT first-phase handoff note (env: WERKMEISTER_WORK_TYPE; config: work_type).
- `--context-strategy <id>`: Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). (env: WERKMEISTER_CONTEXT_STRATEGY; config: context_strategy).
- `--harness <id>`: Agent harness that reads the workspace: claude (CLAUDE.md, .claude/, hooks), mcp (AGENTS.md, .agents/skills, no hooks), codex (AGENTS.md, .agents/skills, .codex/hooks.json, .codex/config.toml) or opencode (AGENTS.md, .agents/skills, opencode.json, hooks plugin) (env: WERKMEISTER_HARNESS; config: harness).
- `--autonomous`: Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a headless session needs (env: WERKMEISTER_AUTONOMOUS; config: autonomous).
- `--model <tier|model>`: Model tier (small, mid, frontier, advanced_frontier) or an explicit model; blank = models.default_tier in ~/.werkmeister/config.yaml (frontier) (env: WERKMEISTER_MODEL; config: model).
- `--auto-stop`: Stop this workspace's feature containers when a Claude session in it ends and no other is open (a SessionEnd hook; env: WERKMEISTER_AUTO_STOP; config: auto_stop).
- `--config <path>`: Path to a YAML config file (JSONC/JSON also accepted). Defaults to \<workspace>/.werkmeister/workspace.yml; legacy workspace.yaml / workspace.jsonc / workspace.json are migrated on next write (env: WERKMEISTER_WORKSPACE_CONFIG).
- `--prune-context`: After a context_strategy change, delete the previous strategy's files that git tracks unmodified (anything else is kept and reported).
- `--refresh-issue`: Re-fetch the workspace's issue into .werkmeister/issue.md (BRIEF.md is not rewritten, except an untouched placeholder brief).

Reconciles a workspace from its `.werkmeister/workspace.yml` and regenerates its context files. It adds a git worktree for each repo the config needs (its `repos` plus the repos owning its `services`) and removes worktrees for repos it dropped; a dirty worktree stops the run unless `--force`. Then it writes CLAUDE.md, `.env`, `compose.yml`, the `.claude/` skills and agents, `.mcp.json`, `.devcontainer/devcontainer.json` (harness: claude only) and `.werkmeister/*`.

It is idempotent: edit `workspace.yml` and rerun. It never prompts, and refuses to run in a bare folder; create a workspace with `werkmeister workspace new`.

**Examples**

```bash
werkmeister workspace init
werkmeister workspace init --services backend,frontend
werkmeister workspace init --refresh-issue
werkmeister workspace init --no-build
```

#### werkmeister workspace close

End a workspace after every PR shipped: close the issue, write closeout.md, remove the workspace, delete merged branches. Refuses without postmortem.md (run the post-mortem first) unless --skip-postmortem gives a reason

`werkmeister workspace close [name]`

- `-y, --yes`: Skip the confirmation prompt
- `--skip-postmortem <reason>`: Close out without a post-mortem; the reason goes in closeout.md
- `--no-pr <reason>`: Close out as done although there are no PR files: the work changed no repo (clean worktrees, no commits ahead). Needs postmortem.md; the reason goes in closeout.md and on the issue

The one way to end a workspace that shipped. First the post-mortem: it refuses without `postmortem.md` unless `--skip-postmortem` gives a reason. After every PR shipped, it closes the issue, writes `closeout.md`, removes the workspace and deletes merged branches. When the work changed no repo, so there are no PR files, `--no-pr "<reason>"` closes it as done instead: it needs `postmortem.md`, clean code worktrees and no commits ahead of their base, and the reason goes in `closeout.md` and on the issue. To end a workspace without shipping, use `werkmeister workspace abandon "<reason>"`. It lists terminal Claude sessions still open in the workspace.

The full process is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

**Examples**

```bash
werkmeister workspace close
werkmeister workspace close --no-pr "the fix lives in ~/.claude, outside every repo"
```

#### werkmeister workspace abandon

End a workspace without shipping: record the reason in closeout.md and the PR files, push every branch and keep them, remove the workspace

`werkmeister workspace abandon <reason> [name]`

- `-y, --yes`: Skip the confirmation prompt
- `--skip-postmortem <reason>`: Close out without a post-mortem; the reason goes in closeout.md

Ends a workspace whose work won't ship: superseded, out of scope, or stopped. Like `werkmeister workspace close`, it refuses without `postmortem.md` unless `--skip-postmortem` gives a reason. Then it records the reason in `closeout.md` and the PR files, pushes every code branch that has commits of its own and keeps it, and removes the workspace. On the issue it posts `Abandoned: <reason>` and moves it to the `abandoned` status (on Jira none by default, a comment only; on GitHub closed as not planned; see [Issue status](workspace-lifecycle.md#issue-status)). Use `werkmeister workspace close` instead once every PR has shipped, or with `--no-pr` when the work changed no repo. It lists terminal Claude sessions still open in the workspace.

The full process is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

**Examples**

```bash
werkmeister workspace abandon "superseded by SW-200"
werkmeister workspace abandon "superseded by SW-200" my-feature
```

### PRs and issues

#### werkmeister pr

Open and track this workspace's PRs from its PR files (docs/workspace-lifecycle.md)

`werkmeister pr [command]`

Opens PRs from a workspace and tracks them to a release. Each action:

- `gate` runs the pre-PR gate for each PR file and changes nothing.
- `gate --tests` runs only the gate's lint and test rows, in the workspace container, on each worktree's uncommitted tree (committed, staged, unstaged and untracked changes since its base). It needs no PR file and skips the PR-file, clean, baseline and release rows. It starts a container when none is running and stops it after. The implement stage runs it, so a failure that only happens with the container's env shows up before `pr open`.
- `open` gates, pushes and opens a PR for each PR file at `status: approved`, and records its URL.
- `gate` and `open` don't wait on host load before their checks: the 1-minute load counts the gate's own install and test rows, and the services the gate starts are already admitted against the budget. `--no-wait` is still accepted and does nothing. With tests, a gate can run past a 10-minute tool call: run `pr open` detached, as rule 3 of `_shared/pr-rules.md` shows. `.werkmeister/bin/with-temp-home` runs a shorter wait (up to 90 s) before its command and exits 75 without running it if load is still over (`WERKMEISTER_NO_WAIT=1` skips it). Each service the gate starts waits up to 10 minutes for room in the budget, then fails with `NO_CAPACITY`. A start that runs a setup service (the install) first waits up to 90 s while the host load is over `budget.host_load`, then fails with `HOST_LOAD`; `WERKMEISTER_NO_WAIT=1` skips that wait, `--no-wait` does not, and macOS never waits. A failed check ends with the host load.
- `status` records merged, shipped or closed from GitHub and the repo's release tags.
- `adopt` records a PR opened outside the workspace.
- `watch` resumes each opening session once its PR merges, ships or closes; `--install` schedules it.
- `new` starts a follow-up PR file and branch for a worktree whose PRs have merged.

Inside a workspace, `gh pr create` (and so `/create-pr`) is blocked by a PreToolUse hook; `werkmeister pr open` is the way to open a PR. The full process (PR files, the gate, ship detection, the PR guard) is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

**Examples**

```bash
werkmeister pr gate
werkmeister pr gate --tests
werkmeister pr open
werkmeister pr status --json
```

**See also**

`werkmeister workspace close` ends the workspace once its PRs have shipped.

#### werkmeister pr gate

Run the pre-PR gate

`werkmeister pr gate [repo]`

- `--tests`: Only the lint and test rows, on the uncommitted tree, before a PR file exists
- `--json`: Print the result as JSON

#### werkmeister pr open

Gate, push and open each approved PR file

`werkmeister pr open [repo]`

- `--json`: Print the result as JSON

#### werkmeister pr status

Record merged, shipped or closed for each PR file

`werkmeister pr status [repo]`

- `--json`: Print the result as JSON

#### werkmeister pr adopt

Record a PR opened outside the workspace

`werkmeister pr adopt [pr] [repo]`

- `--no-pr <reason>`: No PR — the fix is already on base
- `--json`: Print the result as JSON

#### werkmeister pr watch

Resume each opening session once its PR merges, ships or closes (any workspace)

`werkmeister pr watch`

- `--install`: Install a schedule (launchd on macOS, else crontab) that runs `pr watch` every 10 minutes
- `--uninstall`: Remove that schedule
- `--json`: Print the result as JSON

#### werkmeister pr new

Start a follow-up PR file and branch for a worktree whose PRs have merged

`werkmeister pr new [worktree]`

- `--slug <slug>`: The follow-up's name, in its PR file and branch
- `--json`: Print the result as JSON

#### werkmeister issue

Read, update or file an issue in this machine's issue tracker (see `werkmeister machine setup`)

`werkmeister issue [command]`

Reads or updates one issue in this machine's tracker (`werkmeister machine setup` picks it).

- `view` prints the issue's briefing; `--json` prints it as JSON.
- `update` moves its status and/or adds a comment; at least one is required.
- `create` files a new issue and prints its URL. `--relates <key>` (repeatable) then links it "relates to" each key and prints each link; every key's format is checked (exactly one key per value, no comma lists; not that it exists) before the issue is filed. Only trackers with an API path (Jira); file GitHub issues with `gh issue create`.
- `start` moves the workspace's issue to in progress, forward only, then fetches each code worktree's base: a branch with no commits of its own is fast-forwarded, any other gets an `N commits behind <base>` line. It exits 0 when the tracker refuses or a fetch fails, so a stage never fails on it.
- `ready` lists a project's open work in priority order: its board's ready column, else the open issues.

Inside a workspace the issue reference can be left out: it is read from `.werkmeister/workspace.yml`.

**Examples**

```bash
werkmeister issue view
werkmeister issue update --status "In Review" --comment "PR opened"
werkmeister issue create --project SW --type bug --title "Short summary" --body-file body.md
werkmeister issue create --project SW --type task --title "Follow-up" --body-file body.md --relates SW-292 --relates SW-263
werkmeister issue ready --json
```

#### werkmeister issue view

Print the issue

`werkmeister issue view [ref]`

- `--json`: Print JSON

#### werkmeister issue update

Change the issue's status and/or add a comment

`werkmeister issue update [ref]`

- `--status <name>`: Move the issue to this status
- `--comment <text>`: Add this comment

#### werkmeister issue create

File a new issue and print its URL (Jira)

`werkmeister issue create`

- `--project <key>`: The Jira project key to file in
- `--type <type>`: bug, feature or task (mapped to the tracker's issue type)
- `--title <text>`: The issue's summary
- `--body-file <path>`: The issue's description, from a file (- for stdin)
- `--relates <issue>`: Link the new issue 'relates to' this one (repeatable)

#### werkmeister issue start

Move the workspace's issue to in progress and fast-forward its worktrees

`werkmeister issue start [ref]`

#### werkmeister issue ready

List a project's open work in priority order

`werkmeister issue ready`

- `--project <key>`: A project from projects: in config.yaml
- `--json`: Print JSON

### Services and infra

#### werkmeister infra intercept

Route header-scoped k8s dev traffic to a local service (Telepresence OSS).

`werkmeister infra intercept [feature]`

- `-s, --service <name>`: Local service to intercept (must be in the workspace's SERVICES and running via `werkmeister feature up`).
- `--leave`: End the intercept for -s (or all of this feature's intercepts without -s).
- `--status`: Show telepresence connection and intercept status.
- `--docker-daemon`: Run the telepresence daemon in a container (connect --docker) — avoids the host TUN device, its sudo prompt, and VPN routing conflicts. In exchange the host loses cluster DNS: nothing on your laptop resolves \<svc>.\<ns> while connected this way.
- `--workspace <path>`: Explicit workspace path (default: resolve from the feature name).

Only requests carrying `x-feature: <feature>` are rerouted; teammates and baseline dev
traffic reach the cluster workload untouched. The intercept target is the container
`werkmeister feature up` already published on the feature's slot port, so hot reload keeps working.

**Two daemon modes.** Telepresence has to get cluster traffic onto your laptop, and there
are two places its daemon can live. [docs/topology.md](topology.md) draws the whole picture,
including what changes when the cluster is a managed one in the cloud.

| | host mode (default) | `--docker-daemon` |
|---|---|---|
| Asks for your password | **Yes** — root creates a TUN device, writes `/etc/resolver/*`, adds routes | **No** |
| Cluster DNS on the host (`backend.default` resolves in your shell) | Yes | **No** |
| VPN routing conflicts | Possible — both want the routing table | Avoided |
| Requires a working Docker | Only for your services | Yes, for the daemon too |

The password prompt is telepresence's own `sudo`, not Werkmeister's. It comes once per root
daemon lifetime — until `telepresence quit -s` or a reboot — not once per intercept.

Pick host mode when you want to `curl backend.default` or point host-side tooling at cluster
names. Pick `--docker-daemon` when the password prompt or a VPN is in your way, and accept
that cluster names resolve nowhere on the host while it is connected. Traffic flowing
cluster → laptop, which is what an intercept is for, behaves identically in both.

Switching modes means dropping the current daemon first:

```bash
telepresence quit -s
werkmeister infra intercept my-feature -s backend --docker-daemon
```

**On OrbStack** (the default `k8s_context`), docker mode works with no extra configuration.
Two details, both verified live rather than assumed:

- The kubeconfig points at `https://127.0.0.1:26443`, which inside a container would be the
  container itself. Telepresence ≥ 2.31 rewrites it to `host.docker.internal` on its own,
  and OrbStack's API certificate already covers that name — so `connect --docker` needs no
  `--server` override.
- The intercept does need `--address host.docker.internal`, which the CLI passes for you.
  Without it telepresence forwards to `127.0.0.1` *inside the daemon container*, and the
  cluster's request dies as `{"error":"EOF"}` while your local container sits idle.

```bash
# Start the feature first (with backend in workspace.yml's services) — the local container is the intercept target
werkmeister feature up my-feature
werkmeister infra intercept my-feature -s backend --docker-daemon

# From inside the cluster: the header reaches your laptop, bare traffic does not
kubectl run probe --rm -i --restart=Never --image=curlimages/curl:latest --quiet -- \
  curl -s -H "x-feature: my-feature" http://backend.default/

werkmeister infra intercept my-feature --leave -s backend
```

A service can only be intercepted if it declares `k8s_deployment`, `k8s_namespace` and
`k8s_port` in the registry; `werkmeister feature status --intercepts` reports what is interceptable and
what is currently intercepted.

#### werkmeister infra connect

Start all shared infrastructure (local + k8s port-forwards)

`werkmeister infra connect`

- `--k8s`: Start/restart k8s port-forwards container only (replaces standalone k8s-connect command)

**`--k8s`** starts or checks only the containerized k8s port-forwards. Starts the `k8s-forwards` Docker container (part of `apps/cli/infra/compose/shared-infra.yml`), which runs one `kubectl port-forward` process per entry in the generated forwards table, all inside a single container. If the container is already healthy, the command says so and does nothing.

The container runs on the `werkmeister-shared` Docker network and is accessible to other containers via the DNS name `k8s-forwards`. Port-forward processes inside the container auto-restart if they disconnect, managed by the container's entrypoint script.

```
=== k8s Connect ===

[info] Attempting to start/restart k8s-forwards container...
[ok]   k8s port-forwards started
```

If the forwards can't be started, it prints `Failed to start k8s port-forwards.` and points at Docker and your kubeconfig. `werkmeister infra status` lists each forward and whether it is alive.

Without `--k8s`, it starts all shared infrastructure, waits up to 90 seconds for it to settle, then prints a health summary (`caddy`, `k8s-forwards` and any opted-in tools), the issue-tracker check, and the developer-tool links:

```
=== Werkmeister Connect ===

--- Health Summary ---

  caddy                          healthy
  k8s-forwards                   healthy

  All 2 services healthy
```

#### werkmeister infra proxy-reload

Regenerate Caddyfile and reload Caddy

`werkmeister infra proxy-reload`

Reads all active slot assignments, regenerates `~/.werkmeister/infra/proxy/Caddyfile`, and reloads (or starts) Caddy. Useful after manual config changes or if the proxy gets out of sync.
Warns about routed hostnames that do not resolve to 127.0.0.1 on this machine and prints the `/etc/hosts` line to add.

#### werkmeister infra up

Up the shared infrastructure (Caddy, k8s port-forwards)

`werkmeister infra up`

#### werkmeister infra down

Down the shared infrastructure (Caddy, k8s port-forwards)

`werkmeister infra down`

- `-v, --volumes`: Also remove Docker volumes

#### werkmeister infra restart

Restart the shared infrastructure (Caddy, k8s port-forwards)

`werkmeister infra restart`

#### werkmeister infra stop

Stop the shared infrastructure (Caddy, k8s port-forwards)

`werkmeister infra stop`

#### werkmeister infra status

Show k8s port-forward health

`werkmeister infra status`

- `--json`: Output structured JSON (useful for agent-driven diagnosis)

### Agent context

#### werkmeister skills

Workspace w9r-* skill projection: verify freshness against the werkmeister repo (check) or rewrite it (sync)

`werkmeister skills <action>`

Keeps a workspace's context layer fresh. `check` renders it again and diffs that with what is on disk, exiting 1 with a per-entry report when anything is stale. `sync` rewrites whatever `check` reports. What counts as the context layer depends on the workspace's strategy: for jit, the w9r-* skills in `.claude/skills/` and the gate manifest; for icm, `_shared/standards.md` and the stage contracts.

Run it from anywhere inside a workspace.

**Examples**

```bash
werkmeister skills check
werkmeister skills sync
```

**Exit codes**

0 when fresh (or synced), 1 when `check` finds drift.

#### werkmeister standards

Validate the configured standards tree (structural regression gate)

`werkmeister standards <action>`

Checks the configured standards tree for structural errors and exits 1 on any, so a malformed standards edit fails loudly instead of silently dropping out. It also checks each repo's own tree (`<repo>/.werkmeister/standards/`, for every main checkout under `paths.repos_root`) and fails when a repo module reuses a global module's `domain`. It prints the tree's path. Unlike `werkmeister skills check`, it is not tied to a workspace.

**Examples**

```bash
werkmeister standards check
```

#### werkmeister notes

Workspace notes (.werkmeister/notes/). `context` prints the latest handoff + open decisions for session-start injection (hook target); `graduate` scaffolds an open decision note into the standards tree.

`werkmeister notes <action> [note_num]`

- `--domain <domain>`: graduate: target \<domain> in the standards tree (omit to infer from refs, or prompt)
- `--kind <kind>`: graduate: content kind to scaffold (omit to prompt)
- `--slug <slug>`: graduate: override the derived reference-file slug

`context` prints the workspace's notes context for a fresh Claude Code window. It is the SessionStart hook's target: it reads the hook's payload on stdin, never fails, and always exits 0.

`graduate` scaffolds an open `decision` note into the standards tree. At a terminal it asks for the domain and kind; otherwise pass `--domain` and `--kind`.

**Examples**

```bash
werkmeister notes context
werkmeister notes graduate 3 --domain testing --kind rule
```

### Machine

#### werkmeister machine detect

Generate \<repo>/.werkmeister/services.yaml from the repo's package manifests, Dockerfiles, compose, Helm and k8s files (re-runs only add what is missing)

`werkmeister machine detect [repo]`

- `--dry-run`: Show the report and the proposed YAML; write nothing
- `-y, --yes`: Write without asking
- `--assist`: Ask Claude to resolve the fields the scan had to guess
- `--no-assist`: Never ask Claude

It reads `package.json` and workspaces (npm, pnpm, yarn), Dockerfiles, docker-compose files, Helm charts (rendered with `helm template`), raw k8s manifests and kustomize overlays (`kubectl kustomize`). For each value the report shows where it came from, and every guess is marked. Guesses are written with a `# guessed:` comment, so they're easy to find and fix.

`port_offset` is picked from the offsets no other repo under `paths.repos_root` uses. The shared install service's `node_modules_volume` is named `<repo>-node-modules`, and with a lockfile its command never rewrites the lockfile (for pnpm, `pnpm install --frozen-lockfile`). Infrastructure (redis, postgres and other datastores) gets the next free `k8s_forward_port` from 9050.

Re-running only adds services and keys the file doesn't have yet. Nothing already in the file changes: not values, comments or formatting. After writing, run `werkmeister registry sync`.

`--assist` runs one read-only Claude session (Read, Glob and Grep only) over the repo. It only answers the listed questions: a non-Node service's dev command, health path, environment, secrets, `depends_on`, and which service an unmatched Deployment belongs to. Answers are written with `# inferred by Claude:` and never replace a value the scan read from a file.

#### werkmeister machine clean

Remove orphaned volumes and generated files from stopped features

`werkmeister machine clean`

- `--all`: Also clean volumes for currently active features (implies werkmeister down for each)
- `--dry-run`: Show what would be cleaned without actually removing anything

**What it does:**

1. Identifies per-feature Docker volumes (node_modules, build caches) that belong to stopped features
2. Removes those orphaned volumes
3. Releases stale slot entries (features with no running containers or compose file)

With `--all`, it first stops all active features (equivalent to running `werkmeister feature down --volumes` for each), then cleans everything.

**When to use:**
- After extended development with many features started and stopped — volumes accumulate
- Before a fresh start: `werkmeister machine clean --all`
- To check what would be cleaned: `werkmeister machine clean --dry-run`

#### werkmeister machine tokens

List daemon tokens with no workspace; --remove deletes them

`werkmeister machine tokens`

- `--remove`: Delete the stale tokens (default: list only)

**What it does:**

1. Lists the files in `~/.werkmeister/tokens` whose name is not a folder under the workspaces root (`paths.workspaces_root`)
2. With `--remove`, deletes them. A workspace's own token is never touched

Without `--remove` nothing changes. If the workspaces root cannot be read or holds no workspace folder, nothing is removed and the command exits 1.

**When to use:**
- Once after upgrading past 0.74.0: core tests from older versions left tokens there (see the release notes for the name prefixes)
- After deleting a workspace folder by hand

A removed token is minted again by the next `werkmeister workspace init` for that workspace.

A workspace that lives outside the workspaces root counts as stale: keep `paths.workspaces_root` correct before using `--remove`.

#### werkmeister machine stats

Show Docker container resource usage (CPU, memory)

`werkmeister machine stats`

- `--collect <MINUTES>`: Collect stats over N minutes (default: snapshot only)
- `-i, --interval <SECS>`: Sampling interval in seconds (default: 10)
- `--save`: Save results to stats/ directory

Shows Docker resource usage for every werkmeister container: one snapshot by default, or samples collected over a period.

**Examples**

```bash
werkmeister machine stats                     # snapshot of current usage
werkmeister machine stats --collect 5         # collect for 5 minutes
werkmeister machine stats --collect 30 -i 5   # 30 minutes, 5-second intervals
```

**See also**

`werkmeister machine optimize` compares the same numbers with the configured limits.

#### werkmeister machine optimize

Analyze resource usage vs configured limits, recommend changes

`werkmeister machine optimize`

- `--collect <MINUTES>`: Collect stats over N minutes before analyzing (default: quick snapshot)
- `-i, --interval <SECS>`: Sampling interval in seconds (default: 10)

Compares running containers' actual usage with their configured limits, shows which services are over- or under-provisioned, and recommends changes.

**Examples**

```bash
werkmeister machine optimize              # analyze current usage against the limits
werkmeister machine optimize --collect 5  # collect for 5 minutes first, then analyze
```

#### werkmeister machine setup

Guided machine setup: walks through paths, ingress domains and the ~/.werkmeister service registry, then converges the plugins, the sandbox-workspace checkout, the TLS certificate and the optional issue tracker, Telepresence and VS Code YAML-schema prerequisites <!-- name-check: ignore -->

`werkmeister machine setup`

- `--check`: Report prerequisite state without prompting or running any install/update commands
- `--yes`: Non-interactive: accept every default and skip optional installs

The guided first run (and re-run) of a werkmeister machine. It asks everything up front, then walks through each prerequisite that lives outside the checkout: paths, browser, ingress, the service registry, the issue tracker, and optional tools (telepresence, the superpowers plugin, editor settings). It writes the machine-global config in `~/.werkmeister` and converges the rest.

**Examples**

```bash
werkmeister machine setup           # guided
werkmeister machine setup --check   # report state, change nothing
werkmeister machine setup --yes     # accept every default
```

#### werkmeister machine config

Set up and maintain the machine-global werkmeister config (~/.werkmeister/config.yaml — the single source of truth); regenerates env.sh and wires up ~/.zshenv and the Desktop MCP config

`werkmeister machine config`

- `--write`: Write config.yaml (prompting on a TTY for unset values), regenerate env.sh, and wire up ~/.zshenv and the Desktop MCP config. Without it (or a value to set) the command only prints the config.
- `--repos-root <path>`: Absolute path to the canonical source-repo clones (non-interactive set).
- `--workspaces-root <path>`: Absolute path to the per-feature worktree workspaces (non-interactive set).
- `--show`: Print the resolved config and each value's origin (the default).
- `--check`: Validate config + derived files; nonzero exit on drift.

Sets up and maintains the machine-global configuration, `~/.werkmeister/config.yaml`, the single source of truth. Writing it also regenerates `~/.werkmeister/env.sh` and keeps a managed block in `~/.zshenv` that sources it. The `WERKMEISTER_*` environment variables are derived from the YAML, not read as input.

**Examples**

```bash
werkmeister machine config                       # print the resolved config, origins and the whole YAML with secrets (e.g. jira.api_token) masked; safe for agents
werkmeister machine config --write               # interactive wizard, then write
werkmeister machine config --check               # validate; nonzero exit on drift
```

#### werkmeister machine migrate

Move ~/.sandbox to ~/.werkmeister and repoint everything that names it: config.yaml, env.sh, the ~/.zshenv block, services.yaml, the pr-watch schedule and workspace compose files; then rewrite workspace hooks, permission rules and with-temp-home, secrets.env and Claude Desktop's args to the noun-group spellings. Safe to re-run; refuses while affected containers are running. <!-- name-check: ignore -->

`werkmeister machine migrate`

- `--workspaces`: Also rename each workspace's .sandbox/ to .werkmeister/. <!-- name-check: ignore -->
- `--check`: Report what would change without writing.

A one-shot move of the pre-rename machine folder to `~/.werkmeister`, repointing every file that carries the old path. Safe to re-run; it refuses while containers the move would break are running. Pull and rebuild the CLI before you migrate.

It also brings what an older CLI wrote up to the noun-group spellings: each workspace's hooks, permission rules and `with-temp-home`, the stale pre-rename MCP token in `secrets.env`, and Claude Desktop's server args. A workspace whose `.env` still exports only `SANDBOX_FEATURE` is listed; run `werkmeister workspace init` there.

**Examples**

```bash
werkmeister machine migrate --check
werkmeister machine migrate --workspaces
```

#### werkmeister cache

Prune the shared build and package caches (`caches:` in the registry) by each one's age or prune rule

`werkmeister cache <action> [name]`

- `--reset`: Empty the cache(s) instead of applying the rule.
- `--force`: Prune a cache even while a running container mounts it.
- `--dry-run`: Report what would be deleted; change nothing.

Applies each shared cache's rule from the registry's `caches:`: `max_age` deletes older entries, `prune` runs the tool's own command. `--reset` empties the cache instead. A cache that a running container mounts is skipped unless `--force`.

**Examples**

```bash
werkmeister cache prune
werkmeister cache prune --dry-run
werkmeister cache prune --reset
```

#### werkmeister registry

Regenerate ~/.werkmeister/services.yaml from every \<repo>/.werkmeister/services.yaml under paths.repos_root (merged under ~/.werkmeister/services.local.yaml)

`werkmeister registry [action]`

- `--check`: Report drift without writing; nonzero exit when stale.
- `--from <worktree>`: Use this checkout's .werkmeister/services.yaml for its repo (needs --out).
- `--out <file>`: Write the registry here instead of ~/.werkmeister/services.yaml.

Regenerates `~/.werkmeister/services.yaml` from every repo's `.werkmeister/services.yaml` fragment under `paths.repos_root`, merged under `~/.werkmeister/services.local.yaml`. It is the same step `werkmeister machine setup` runs, on its own: use it after cloning a new repo. `werkmeister pr status` runs it too when a merged PR changes a fragment and the repo sets `sync_on_merge: auto` ([Ship detection](workspace-lifecycle.md#ship-detection-registry-repo)).

To prove a fragment change before it merges, `--from <worktree>` takes that checkout's `.werkmeister/services.yaml` in place of its repo's fragment under `paths.repos_root`, and `--out <file>` writes the merged registry there instead of `~/.werkmeister/services.yaml` (which is never touched, nor is `services.local.yaml` seeded). `--check` compares against `--out` the same way.

**Examples**

```bash
werkmeister registry            # regenerate (sync is the default action)
werkmeister registry --check    # report drift; nonzero exit when stale
werkmeister registry --from ./werkmeister --out /tmp/services.yaml          # branch fragment, temp registry
werkmeister registry --check --from ./werkmeister --out /tmp/services.yaml  # is that file current?
```

#### werkmeister budget

The scheduler's budget, the slots held and the features Waiting for room

`werkmeister budget [command]`

Shows the scheduler's budget and who is using it: the memory and CPUs a feature's containers may take in total (`budget:` in `~/.werkmeister/config.yaml`, else the Docker engine's memory less 1 GiB and every CPU), the host-load ceiling `with-temp-home`, and a start that runs a setup service, wait under (not on macOS), whether a start that doesn't fit may stop features whose session is idle or waiting on a person (and a person's `feature up` a working autonomous one), the features holding a slot, and the features **Waiting** for room in the order they will start.

It reads only: with the host daemon up it asks the daemon for the queue, otherwise it reads `~/.werkmeister/scheduler/` itself.

**Examples**

```sh
werkmeister budget status
werkmeister budget status --json
```

#### werkmeister budget status

Show the budget, the slots held and the features Waiting for room

`werkmeister budget status`

- `--json`: Print JSON

#### werkmeister daemon

The host daemon (the MCP server on port 3002)

`werkmeister daemon [command]`

The host daemon is the werkmeister MCP server on port 3002 (`overrides.mcp_port`). The VS Code extension, the SessionEnd stop and the scheduler reach it over HTTP. On macOS, launchd keeps it up once it is installed; elsewhere `werkmeister infra connect` starts it with a PID file.

- `status` says whether it is serving, which build it loaded (`stale (loaded <x>, on disk <y>)` after a rebuild or upgrade), and whether the launchd agent is installed and current.
- `install` writes or refreshes the launchd agent: the same step `werkmeister machine setup` offers.
- `uninstall` removes the agent and stops launchd's copy; `infra connect` starts it again.
- `restart` restarts it, through launchd when launchd owns it.

Under launchd the daemon restarts itself on a new build: once its entry changes and no call or queued feature is in flight, it exits and launchd starts it on the new code. A PID-file daemon only reports `stale`; run `restart`. The CLI warns once per run when it reaches a daemon on another build.

Claude Code and Claude Desktop sessions reach it through `werkmeister internal mcp`, a stdio proxy, so a running session gets the new build's tools without a `/mcp` reconnect. Only a change to the proxy itself needs a reconnect or a session restart; the release notes say when.

**Examples**

```sh
werkmeister daemon status
werkmeister daemon install
```

#### werkmeister daemon status

Say whether the daemon is serving and its launchd agent is current

`werkmeister daemon status`

- `--json`: Print JSON

#### werkmeister daemon install

Install or refresh the launchd agent (macOS)

`werkmeister daemon install`

#### werkmeister daemon uninstall

Remove the launchd agent; `infra connect` starts the daemon again

`werkmeister daemon uninstall`

#### werkmeister daemon restart

Restart the daemon, through launchd when launchd owns it

`werkmeister daemon restart`

<!-- /generated -->

## Debugging

Set the `WERKMEISTER_DEBUG` environment variable to get full stack traces on errors:

```bash
WERKMEISTER_DEBUG=1 werkmeister up my-feature
```

## Description

The local services come from the workspace's `.werkmeister/workspace.yml` (via `werkmeister workspace init`), not from a flag.

**What it does:**

1. Loads the service registry and port configuration, and stops with a clear message if a secret one of the workspace's services needs is missing
2. Resolves the workspace (`--workspace`, else `paths.workspaces_root` from the config, else the nearest enclosing repo's parent, else `~/workspace/`) and reads its local services from the `SERVICES=` line `werkmeister workspace init` wrote to the workspace `.env`
3. Allocates a slot (1–12) if the feature doesn't already have one
4. When the workspace has local services, checks the host's memory and CPU budget (`werkmeister budget status`). If the feature doesn't fit it waits in a queue and starts when another feature stops. A start that fits goes ahead of a queue head that doesn't, unless that head is a gate's start or has waited 5 minutes. A queued whole-feature head that would fit holds nothing: only another feature stopping starts it. The queue head may stop features whose session is idle or waiting on a person (a question or plan; a permission prompt is mid-turn and is not), oldest first, and says which: a service start at once, a plain `feature up` after 5 minutes. It never stops a feature started in the last 5 minutes, whose session may not have had its first turn yet; only a person's start can. A feature a person starts may also stop working autonomous ones (`budget.preempt: false` turns all of it off). A `--service` start that has to wait while an autonomous workspace's feature already runs containers stops them first, so it holds nothing while it waits, then starts them again with the new service
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

**If the feature has to wait for capacity**, the command exits 75 without starting containers. It prints `=== Feature '<name>' is waiting for capacity (position N) ===`, who holds the budget, what the start needs against what is free, and the head it waits behind. The feature stays queued and starts by itself when room frees, and its session is told to continue. A `--service` start waits up to 10 minutes, then exits 75 the same way and stays queued: it starts by itself when room frees, and a rerun keeps its place. One that stopped the feature's running containers to wait does not stay queued: `werkmeister feature up` starts the feature again. Exit 75 means no capacity yet, not a failure. `werkmeister budget status` shows the queue.

**What a queued session can do.** While its whole feature waits (`.werkmeister/waiting.json`), the werkmeister hook denies the session's commands that need its containers or the CPUs: `docker`, `pnpm`, `npm`, `npx`, `node`, `turbo`, `vitest`, `with-temp-home`, `werkmeister feature restart`, `pr gate` and `pr open`, and their MCP forms. Everything else passes: edits, git, `werkmeister feature stop`, `werkmeister budget status`, a lone `docker ps`, and `werkmeister feature up`, which only asks admission again (exit 75 while there is no room) and so starts a queued feature once room frees, for example after `budget:` grows. The deny does not end the turn, so the session goes on with other work. Before it denies, the hook asks Docker whether the feature's containers already run; if they do, the queue entry is stale, and it removes `waiting.json` and lets the command through. When a grant starts the feature, the session is told `Capacity freed: … Continue where you left off.`: the workspaces pane sends that to the workspace's Desktop session, and keeps it for its next refresh when the send fails. A `--service` start's own wait holds nothing, since its poll is the session's own command. A paused workspace holds every tool and ends the turn.

**If compose gives up with a container left Created** (its 20-minute limit ran out under load, and the container was created but never started), `up` starts that container itself, warns `docker compose gave up with <name> left Created; started it directly`, and carries on. It doesn't when another of the feature's containers failed (exited non-zero or unhealthy), since compose holds its dependents back on purpose: then the compose failure stands. A container that still won't start fails the command, naming it and the `docker start <name>` that starts it by hand.

**If every slot is taken** (12 by default, `feature_slots.count`), the command exits with an error. Free a slot by running `werkmeister feature down` on another feature.

**`--service <name>`** starts only that one service, the way the PR gate starts it, and prints `Started <feature>-<name>`.

**Adding a service to a running feature.** To run another service locally, add it to the `services` field in the workspace's `.werkmeister/workspace.yml`, rerun `werkmeister workspace init` (this also adds the owning repo's worktree if it isn't there yet), then `werkmeister feature up`.

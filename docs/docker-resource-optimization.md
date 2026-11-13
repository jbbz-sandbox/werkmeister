# Docker Resource Optimization Guide

How much memory and CPU Werkmeister asks Docker for, how many features fit, and how to tune a service's limits.

## Default budget

`werkmeister feature up` admits a feature only when the budget has room for it.
A feature's cost is what its compose file asks Docker for: the sum of each
service's `memory_reservation` and `cpus` limit, leaving out services behind the
`on-demand` profile. Running features' cost is read from Docker on every `up`.
When there is no room, the feature waits in a queue and its session is held
until another feature stops.

The defaults come from `docker info`, so a new machine needs no setup:

| Key | Default |
|---|---|
| `memory` | the Docker engine's memory minus 1G |
| `cpus` | the engine's CPU count |
| `preempt` | `true`: a start that doesn't fit may stop features whose session is idle or waiting on a person; a person's `up` may also stop a working autonomous one |
| `host_load` | twice the host's CPU count: while the host's 1-minute load is above it, `with-temp-home` waits up to 90 s before its command, and `feature up` and the gate's container starts wait up to 90 s before a setup service (the install) starts, then fail with the load (`HOST_LOAD`); none of them wait on macOS, whose load average is neither the test VM's nor usable; `0` turns the wait off |
| `free_memory` | `15`: while available memory is under this percentage of the total (macOS: `kern.memorystatus_level`; Linux: MemAvailable), `with-temp-home` and a setup start wait up to 90 s as for `host_load`, then exit 75 or fail `HOST_LOAD`, on macOS too; `pr gate` and `pr open` don't wait, they exit 75 with `low memory` before starting a container. Claude Code stops an idle background shell when the Mac runs low; `0` turns it off |

Override any of them in `~/.werkmeister/config.yaml`:

```yaml
budget:
  memory: 6G
  cpus: 8
  preempt: false
  host_load: 24
  free_memory: 10
```

`host_load` limits the gate by live host load, not by reservations: the gate's checks run inside a container that is already admitted, and agents' direct test runs happen on the host where no reservation sees them, so `.werkmeister/bin/with-temp-home` runs the same wait (`werkmeister internal wait-load`) before its command unless `WERKMEISTER_NO_WAIT=1` is set, except on macOS, whose load average is no usable signal. A failed gate check, and a failed `with-temp-home` run, end with the host load so a timeout under load reads as load.

### Measured on a 16 GB laptop

Re-measured 2026-10-31 on a 16 GB MacBook with Docker Desktop's engine
at 7.8 GiB and 12 CPUs, so the default budget is 6.8 GiB and 12 CPUs. Each
service's gate command ran cold (`turbo --force`, nothing cached) in a `node:22`
container limited to 2G, one after the other, while `anon` in the container's
`memory.stat` was sampled every 0.5 s. A reservation is the peak plus about 10%,
rounded up to 64M. One `werkmeister-core` test failed in the bare container, so
its peak is for a gate that ran to the end. The `cli` reservation is lower than
this run's peak: a later run re-measured the gate row at 948 MiB on 2026-11-05 and set
1088M. The Reservation column is what `.werkmeister/services.yaml` sets today.

| Service | Cold gate | Peak anon | Reservation (was) |
|---|---|---|---|
| `werkmeister-core` | 238 s | 644 MiB | 768M (128M) |
| `cli` | 181 s | 1436 MiB | 1088M (128M) |
| `werkmeister-dashboard` | 62 s | 549 MiB | 640M (256M) |
| `werkmeister-vscode` | 45 s | 581 MiB | 640M (128M) |
| `docs-site` | 48 s | 670 MiB | 768M (128M) |

Idle `anon` was about 0 MiB and nothing was OOM-killed.

Since 2026-11-13 `cli` is no longer a service: `werkmeister-core`'s row runs the CLI's
suites too, so core takes `cli`'s 1088M reservation and a 3G limit, and the table below
counts one container.

| | Memory | CPUs |
|---|---|---|
| Admission cost (compose: setup 512M/2.0, `werkmeister-core` 1088M/3.0) | 1600 MiB | 5.0 |
| Features that fit the 7.8 GiB engine (budget 6.8 GiB, 12 CPUs) | 4 | 2 |
| Features that fit a 4 GiB engine (budget 3 GiB, 4 CPUs) | 1 | 0 |

On this laptop two features of this shape fit, and a third waits: CPU runs out
at two, memory at four. On a 4-CPU engine a feature of this shape does not fit at
all, because it asks for 5 CPUs; lower `cpus` on `werkmeister-core` in
`services.yaml`, or give the engine more CPUs.
Agent sessions run outside Docker ([Sizing a machine](#sizing-a-machine) has the numbers), so the laptop's own
memory, not the engine's, limits how many sessions run beside them.

## Sizing a machine

There are two budgets. Containers share the memory you gave Docker (OrbStack or
Docker Desktop → Resources), and that allocation fills long before the machine
does. Agents, browsers and your editor use the rest.

**Inside the Docker allocation**

| What | Each | Note |
|---|---|---|
| A local service | ~0.5 GB | a Node service with hot reload; a JVM or a database is more |
| Caddy | ~20 MB | measured |
| `k8s-forwards` | ~65–250 MB | measured idle; grows with forwards |
| Docker daemon | ~0.5 GB | |

**Outside it**

| What | Each | Note |
|---|---|---|
| A Claude Code agent | ~0.25 GB per process, 2–3 processes per session | 245 MB per process measured 2026-10-25 |
| A Playwright run | ~0.5–1 GB | one Chromium |

**Worked example: 6 features, 2 local services each** (memory in use; how many features `feature up` admits at once is set by reservations and CPU limits, see [Default budget](#default-budget))

- containers: 12 × 0.5 GB = 6 GB, + ~0.6 GB shared → ~7 GB of the Docker allocation
- agents: 6 × ~0.6 GB → ~3.6 GB
- browsers: 2 Playwright runs → ~1.5 GB
- total ≈ 12 GB plus the OS and your editor. On a 32 GB machine with 12 GB given to Docker, the first thing to run out is the Docker allocation, at about ten more local services.

**Measured:** 5 features × 3 local services on a 32 GB machine = 15 GB (2026-10-26).

The number of features is whatever fits: raise the Docker allocation or run fewer services per feature before you touch `feature_slots.count`.

## Where limits are set

### Feature services

Each service in its repo's `.werkmeister/services.yaml` (merged into `~/.werkmeister/services.yaml`, which `werkmeister machine optimize` reads) has `memory_limit`, `memory_reservation` and `cpus` fields:

```yaml
# .werkmeister/services.yaml
services:
  my-api:
    cpus: "1.0"
    memory_limit: 1G
    memory_reservation: 256M
```

The CLI writes them as `deploy.resources` in the feature's generated `<workspace>/compose.yml`.

### Shared infrastructure

The shared infra limits are not user-tunable. They ship read-only in the npm
package (k8s-forwards 4096M, jaeger 256M, redisinsight 256M; Caddy has none), no
`config.yaml` key sets them, and an edit to the installed file is lost on the
next upgrade. `werkmeister infra restart` restarts the stack with them.

## Tune feature limits

### 1. Monitor usage

```bash
# Snapshot of every Werkmeister container: CPU, memory, limit and usage %
werkmeister machine stats

# Collect for 15 minutes with 10-second intervals (default)
werkmeister machine stats --collect 15

# Collect for 30 minutes with 5-second intervals, save to stats/
werkmeister machine stats --collect 30 -i 5 --save
```

Collect while you edit, build, test and use the app, so the peaks are real. Press `Ctrl+C` to stop early; samples already taken are still shown.

`--save` writes two files to `stats/`:

| File | Description |
|------|-------------|
| `docker-stats-{timestamp}.csv` | Raw data for analysis |
| `resource-summary-{timestamp}.txt` | Human-readable summary with recommendations |

### 2. Compare against limits

```bash
werkmeister machine optimize
```

It takes a snapshot (or `--collect N`), loads the limits from `~/.werkmeister/services.yaml`, flags services near their limit (risk of OOM) or over-provisioned, and recommends `max_usage * 1.5`.

Example output:
```
--- Usage vs Configured Limits ---

  Service                         Max Mem     Limit   Usage  Status
  ──────────────────────────────────────────────────────────────────
  feat-myfeature-frontend-1      2.1G     2560M     84%  RISK - near limit
  feat-myfeature-backend-1       892M        4G     22%  OK

--- Recommendations ---

  ! feat-myfeature-frontend-1: Using 84% of memory limit. Consider increasing.
```

### 3. Apply changes

Edit the service's `memory_limit`, `memory_reservation` or `cpus` in `.werkmeister/services.yaml`, then restart the feature:

```bash
werkmeister feature restart my-feature
```

| Setting | Purpose |
|---------|---------|
| `limits` | Hard ceiling — container cannot exceed this |
| `reservations` | Guaranteed minimum — Docker ensures this is available, and the budget counts it |

The generated compose also sets `memswap_limit` equal to each service's memory
limit. Without it Docker allows twice the limit in swap, so a container
near its limit slows down on a host with swap and is killed on one without.

### 4. Verify

```bash
werkmeister machine stats

# Look for OOM kills
docker inspect <container> --format='{{.State.OOMKilled}}'

# Check container logs for memory pressure
docker logs <container> 2>&1 | grep -i "memory\|heap\|oom"
```

### Signs You Need More Resources

| Symptom | Solution |
|---------|----------|
| Container killed with OOM | Increase `memory_limit` in `services.yaml` |
| Slow hot reload / builds | Increase CPU limit |
| "JavaScript heap out of memory" | Increase memory + add `NODE_OPTIONS=--max-old-space-size=X` |
| Container won't start | Check reservations aren't exceeding available Docker resources |

### Signs You Can Reduce Resources

| Symptom | Solution |
|---------|----------|
| `werkmeister machine optimize` shows OVER-PROVISIONED | Reduce memory limit to max + 50% headroom |
| CPU consistently low | Reduce CPU limit |
| Container mostly idle | Consider removing from feature with `werkmeister feature drop` |

## Troubleshooting

### "Cannot allocate memory" on container start

Your total reservations exceed available Docker memory. Either:
- Reduce reservations in `.werkmeister/services.yaml`
- Increase Docker Desktop memory allocation (Settings > Resources)
- Run fewer services with `werkmeister feature drop <feature> <service>`

### Container repeatedly restarting

Check logs for OOM kills:
```bash
docker inspect <container> --format='{{.State.OOMKilled}}'
```

If `true`, increase the `memory_limit` for that service in `.werkmeister/services.yaml`.

### Build/compilation very slow

Node.js builds are CPU-intensive. Ensure:
- CPU limit is at least 1.5-2.0 for build containers
- `NODE_OPTIONS=--max-old-space-size=4096` is set for large builds

### Hot reload not working

Check if the container is being throttled:
```bash
werkmeister machine stats
```

If CPU is consistently at the limit, increase it.

# Docker Resource Optimization Guide

This guide explains how to optimize CPU and memory usage for the Werkmeister Docker environment.

## Overview

By default, Docker containers without resource limits can consume unbounded CPU and memory, leading to:
- Slow development machines
- Containers competing for resources
- Unexpected OOM kills
- Poor laptop battery life

Werkmeister ships with pre-configured resource limits for all services (defined in each repo's `.werkmeister/services.yaml`, merged into `~/.werkmeister/services.yaml`, and `infra/compose/shared-infra.yml`), but you can tune them based on your actual usage patterns.

## Quick Start

```bash
# 1. Check current resource usage (snapshot)
werkmeister stats

# 2. Collect stats over a longer period during typical work
werkmeister stats --collect 15 --save

# 3. Compare usage against configured limits
werkmeister optimize

# 4. Adjust limits in .werkmeister/services.yaml or infra/compose/shared-infra.yml
```

## Where Resource Limits Are Configured

### Feature Services (`.werkmeister/services.yaml`)

Each service in its repo's `.werkmeister/services.yaml` (merged into `~/.werkmeister/services.yaml`, which `werkmeister optimize` reads) has `memory_limit` and `memory_reservation` fields. The Werkmeister CLI uses these when generating per-feature Docker Compose files:

```yaml
# .werkmeister/services.yaml
services:
  frontend:
    memory_limit: 2560M
    memory_reservation: 1024M
  backend:
    memory_limit: 4G
    memory_reservation: 2G
  redis:
    # Infrastructure services don't go here — see shared-infra.yml
```

These values are applied as `deploy.resources.limits.memory` and `deploy.resources.reservations.memory` in the generated Compose file at the feature's workspace root (`<workspace>/compose.yml`).

### Shared Infrastructure (`infra/compose/shared-infra.yml`)

Infrastructure services (k8s-forwards, jaeger, redisinsight, caddy) have resource limits defined directly in `infra/compose/shared-infra.yml`:

```yaml
# infra/compose/shared-infra.yml
services:
  redis:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 64M
        reservations:
          cpus: "0.1"
          memory: 32M
```

## Step 1: Monitor Resource Usage

### Quick Snapshot

```bash
werkmeister stats
```

Shows current CPU and memory usage for all Werkmeister containers, including the configured memory limit and a usage percentage.

### Extended Collection

For more accurate data, collect over a period while doing typical development work:

```bash
# Collect for 15 minutes with 10-second intervals (default)
werkmeister stats --collect 15

# Collect for 30 minutes with 5-second intervals, save to stats/
werkmeister stats --collect 30 -i 5 --save
```

Press `Ctrl+C` at any time to stop collection early — results from samples already taken are still displayed.

### Best Practices for Data Collection

For accurate results, collect stats while doing **typical development work**:

- [ ] Edit code and trigger hot reload
- [ ] Run the build process
- [ ] Execute tests
- [ ] Use the application in the browser
- [ ] Run any CLI tools you normally use

The collector captures peak usage during these activities, which is what we need to set appropriate limits.

### Saved Reports

When using `--save`, two files are written to the `stats/` directory:

| File | Description |
|------|-------------|
| `docker-stats-{timestamp}.csv` | Raw data for analysis |
| `resource-summary-{timestamp}.txt` | Human-readable summary with recommendations |

## Step 2: Analyze and Optimize

```bash
werkmeister optimize
```

This command:
1. Takes a quick snapshot (or use `--collect N` for a longer collection period)
2. Loads the configured limits from `~/.werkmeister/services.yaml`
3. Compares actual usage against configured limits
4. Flags services that are near their limits (risk of OOM) or over-provisioned
5. Generates data-driven limit recommendations based on `max_usage * 1.5`

Example output:
```
--- Usage vs Configured Limits ---

  Service                         Max Mem     Limit   Usage  Status
  ──────────────────────────────────────────────────────────────────
  w9r-caddy                       42M       64M     66%  OK - moderate
  feat-myfeature-frontend-1      2.1G     2560M     84%  RISK - near limit
  feat-myfeature-backend-1       892M        4G     22%  OK

--- Recommendations ---

  ! feat-myfeature-frontend-1: Using 84% of memory limit. Consider increasing.
```

## Step 3: Apply Changes

### For Feature Services

Edit `.werkmeister/services.yaml` and update the `memory_limit` and `memory_reservation` fields:

```yaml
services:
  frontend:
    memory_limit: 4G       # was 2560M
    memory_reservation: 2G  # was 1024M
```

Then restart the affected feature:

```bash
werkmeister restart my-feature
```

### For Shared Infrastructure

Edit `infra/compose/shared-infra.yml` directly:

```yaml
services:
  redis:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M    # increased from 64M
```

Then restart shared infra:

```bash
docker compose -f infra/compose/shared-infra.yml up -d
```

### Understanding Limits vs Reservations

| Setting | Purpose |
|---------|---------|
| `limits` | Hard ceiling — container cannot exceed this |
| `reservations` | Guaranteed minimum — Docker ensures this is available |

**Rule of thumb:** Set reservations to ~50% of limits.

The generated compose also sets `memswap_limit` equal to each service's memory
limit (SW-151). Without it Docker allows twice the limit in swap, so a container
near its limit slows down on a host with swap and is killed on one without.

## Default budget

`werkmeister up` admits a feature only when the budget has room for it (SW-181).
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
| `preempt` | `true`: a person's `up` may stop an autonomous feature to make room |
| `host_load` | twice the host's CPU count: the gate waits before each check while the host's 1-minute load is above it, up to 30 minutes; `0` turns the wait off |

Override any of them in `~/.werkmeister/config.yaml`:

```yaml
budget:
  memory: 6G
  cpus: 8
  preempt: false
  host_load: 24
```

`host_load` limits the gate by live host load, not by reservations (SW-209): the gate's checks run inside a container that is already admitted, and agents' direct test runs happen on the host where no reservation sees them. A failed gate check, and a failed `with-temp-home` run, end with the host load so a timeout under load reads as load.

### Measured on a 16 GB laptop

Measured 2026-10-29 for SW-181 on a 16 GB MacBook with Docker Desktop's engine
at 7.8 GiB and 12 CPUs, so the default budget is 6.8 GiB and 12 CPUs. The feature
was the werkmeister repo with `werkmeister-core` and `cli`, plus the setup
container that installs their dependencies. Each gate command ran cold
(`turbo --force`, nothing cached), one after the other as the gate runs them,
while `anon` in each container's `memory.stat` was sampled every 0.5 s.

| | Memory | CPUs |
|---|---|---|
| Admission cost (compose: setup 512M/2.0, two services 128M/1.0 each) | 768 MiB | 4.0 |
| Cold peak, `werkmeister-core` gate (109 s) | 632 MiB | |
| Cold peak, `cli` gate (187 s) | 689 MiB | |
| Features that fit the default budget | 9 | **3** |

CPU fills up first: three features of this shape fit, and a fourth waits. Memory
would allow nine, by cost or by measured peak. No container was OOM-killed.
Agent sessions run outside Docker (about 0.3–0.6 GB each), so the laptop's own
memory, not the engine's, limits how many sessions run beside them.

## Step 4: Verify and Adjust

After applying limits, verify containers are running correctly:

```bash
# Quick check
werkmeister stats

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
| `werkmeister optimize` shows OVER-PROVISIONED | Reduce memory limit to max + 50% headroom |
| CPU consistently low | Reduce CPU limit |
| Container mostly idle | Consider removing from feature with `werkmeister remove` |

## Reference: Current Default Limits

From `.werkmeister/services.yaml` and `infra/compose/shared-infra.yml`:

| Service | Memory Limit | Memory Reservation | Type |
|---------|-------------|-------------------|------|
| frontend | 2560M | 1024M | Web app (Next.js) |
| backend | 256M | 64M | API server |
| redis | 64M | 32M | Infrastructure |

| k8s-forwards | 256M | 64M | Infrastructure |

## Troubleshooting

### "Cannot allocate memory" on container start

Your total reservations exceed available Docker memory. Either:
- Reduce reservations in `.werkmeister/services.yaml`
- Increase Docker Desktop memory allocation (Settings > Resources)
- Run fewer services with `werkmeister remove <feature> <service>`

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
werkmeister stats
```

If CPU is consistently at the limit, increase it.

## Summary

1. **Monitor** with `werkmeister stats` during real development work
2. **Analyze** with `werkmeister optimize` to compare usage vs limits
3. **Adjust** limits in `.werkmeister/services.yaml` (features) or `infra/compose/shared-infra.yml` (infra)
4. **Restart** affected containers with `werkmeister restart <feature>`
5. **Iterate** as your development patterns change

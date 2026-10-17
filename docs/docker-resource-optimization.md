# Docker Resource Optimization Guide

This guide explains how to optimize CPU and memory usage for the sandbox Docker environment.

## Overview

By default, Docker containers without resource limits can consume unbounded CPU and memory, leading to:
- Slow development machines
- Containers competing for resources
- Unexpected OOM kills
- Poor laptop battery life

The sandbox ships with pre-configured resource limits for all services (defined in `infra/config/services.yaml` and `infra/compose/shared-infra.yml`), but you can tune them based on your actual usage patterns.

## Quick Start

```bash
# 1. Check current resource usage (snapshot)
./sandbox stats

# 2. Collect stats over a longer period during typical work
./sandbox stats --collect 15 --save

# 3. Compare usage against configured limits
./sandbox optimize

# 4. Adjust limits in infra/config/services.yaml or infra/compose/shared-infra.yml
```

## Where Resource Limits Are Configured

### Feature Services (`infra/config/services.yaml`)

Each service in `infra/config/services.yaml` has `memory_limit` and `memory_reservation` fields. The sandbox CLI uses these when generating per-feature Docker Compose files:

```yaml
# infra/config/services.yaml
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
./sandbox stats
```

Shows current CPU and memory usage for all sandbox containers, including the configured memory limit and a usage percentage.

### Extended Collection

For more accurate data, collect over a period while doing typical development work:

```bash
# Collect for 15 minutes with 10-second intervals (default)
./sandbox stats --collect 15

# Collect for 30 minutes with 5-second intervals, save to stats/
./sandbox stats --collect 30 -i 5 --save
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
./sandbox optimize
```

This command:
1. Takes a quick snapshot (or use `--collect N` for a longer collection period)
2. Loads the configured limits from `infra/config/services.yaml`
3. Compares actual usage against configured limits
4. Flags services that are near their limits (risk of OOM) or over-provisioned
5. Generates data-driven limit recommendations based on `max_usage * 1.5`

Example output:
```
--- Usage vs Configured Limits ---

  Service                         Max Mem     Limit   Usage  Status
  ──────────────────────────────────────────────────────────────────
  sandbox-redis                       42M       64M     66%  OK - moderate
  feat-myfeature-frontend-1      2.1G     2560M     84%  RISK - near limit
  feat-myfeature-backend-1       892M        4G     22%  OK

--- Recommendations ---

  ! feat-myfeature-frontend-1: Using 84% of memory limit. Consider increasing.
```

## Step 3: Apply Changes

### For Feature Services

Edit `infra/config/services.yaml` and update the `memory_limit` and `memory_reservation` fields:

```yaml
services:
  frontend:
    memory_limit: 4G       # was 2560M
    memory_reservation: 2G  # was 1024M
```

Then restart the affected feature:

```bash
./sandbox restart my-feature
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

## Step 4: Verify and Adjust

After applying limits, verify containers are running correctly:

```bash
# Quick check
./sandbox stats

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
| `sandbox optimize` shows OVER-PROVISIONED | Reduce memory limit to max + 50% headroom |
| CPU consistently low | Reduce CPU limit |
| Container mostly idle | Consider removing from feature with `sandbox remove` |

## Reference: Current Default Limits

From `infra/config/services.yaml` and `infra/compose/shared-infra.yml`:

| Service | Memory Limit | Memory Reservation | Type |
|---------|-------------|-------------------|------|
| frontend | 2560M | 1024M | Web app (Next.js) |
| backend | 256M | 64M | API server |
| redis | 64M | 32M | Infrastructure |

| k8s-forwards | 256M | 64M | Infrastructure |

## Troubleshooting

### "Cannot allocate memory" on container start

Your total reservations exceed available Docker memory. Either:
- Reduce reservations in `infra/config/services.yaml`
- Increase Docker Desktop memory allocation (Settings > Resources)
- Run fewer services with `sandbox remove <feature> <service>`

### Container repeatedly restarting

Check logs for OOM kills:
```bash
docker inspect <container> --format='{{.State.OOMKilled}}'
```

If `true`, increase the `memory_limit` for that service in `infra/config/services.yaml`.

### Build/compilation very slow

Node.js builds are CPU-intensive. Ensure:
- CPU limit is at least 1.5-2.0 for build containers
- `NODE_OPTIONS=--max-old-space-size=4096` is set for large builds

### Hot reload not working

Check if the container is being throttled:
```bash
./sandbox stats
```

If CPU is consistently at the limit, increase it.

## Summary

1. **Monitor** with `./sandbox stats` during real development work
2. **Analyze** with `./sandbox optimize` to compare usage vs limits
3. **Adjust** limits in `infra/config/services.yaml` (features) or `infra/compose/shared-infra.yml` (infra)
4. **Restart** affected containers with `./sandbox restart <feature>`
5. **Iterate** as your development patterns change

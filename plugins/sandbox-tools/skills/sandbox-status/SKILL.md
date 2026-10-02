---
name: sandbox-status
description: "Comprehensive health overview of the entire developer sandbox environment. Use when the user asks about sandbox status, wants to know what's running, or as a first step before debugging any issue. Also use after `sandbox up`, `sandbox down`, or system restart to verify state."
---

# sandbox-status

Run all of the following checks and present a unified status report.

## Step 1: Structured Snapshot

Get the full sandbox state in one call:

```bash
sandbox status --json
```

This returns structured JSON covering:
- `infrastructure` — all shared-infra containers and their health state
- `k8s_forwards` — per-service k8s forward status with real HTTP health checks
- `features` — active feature slots with containers and port ranges
- `summary` — quick counts: `infra_healthy`, `k8s_alive`/`k8s_total`, `total_features`/`available_slots`

Use this as the primary source of truth. The `k8s_forwards` statuses are HTTP-checked (not just TCP),
so a `"dead"` status means the service is genuinely not responding, not just a port-binding check.

## Step 2: Feature Slots

If `summary.total_features > 0`, review the `features` array from Step 1.
For any feature with `containers_running < containers_total`, tail its logs:

```bash
sandbox logs <feature> [service]
```

## Step 3: Service Health Checks

For any locally-running web services, verify their health endpoints directly:

```bash
for port_name in "11100:backend:/health" "11101:frontend:/"; do
    port=$(echo $port_name | cut -d: -f1)
    name=$(echo $port_name | cut -d: -f2)
    endpoint=$(echo $port_name | cut -d: -f3)
    result=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://localhost:${port}${endpoint}" 2>/dev/null)
    if [ "$result" = "200" ]; then
        echo "PASS: ${name} (port ${port})"
    elif [ -z "$result" ] || [ "$result" = "000" ]; then
        echo "DOWN: ${name} (port ${port})"
    else
        echo "WARN: ${name} (port ${port}) returned HTTP ${result}"
    fi
done
```

## Step 4: Caddy Status

```bash
CADDYFILE="${SANDBOX_CONFIG_FILE:+$(dirname "$SANDBOX_CONFIG_FILE")}"
CADDYFILE="${CADDYFILE:-$HOME/.sandbox}/infra/proxy/Caddyfile"
docker exec sandbox-caddy caddy validate --config /etc/caddy/Caddyfile 2>&1
HOST_SIZE=$(wc -c < "$CADDYFILE" 2>/dev/null)
CONTAINER_SIZE=$(docker exec sandbox-caddy wc -c < /etc/caddy/Caddyfile 2>/dev/null)
echo "Caddyfile: host=${HOST_SIZE}B container=${CONTAINER_SIZE}B"
```

## Step 5: k8s Port-Forward Detail

If Step 1 shows `k8s_alive < k8s_total`, get the full per-service breakdown:

```bash
sandbox status --k8s
```

This performs real HTTP health checks against each forward's health endpoint and shows
the `listen_port → remote_port` mapping. The `listen_port` is what you use on `localhost`
(e.g. frontend is `localhost:9053`, not `localhost:8080`).

## Step 6: Resource Usage

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" 2>/dev/null | head -20
```

## Step 7: Disk Usage

```bash
docker system df 2>/dev/null
```

## Output Format

```
## Sandbox Status Report

### Infrastructure
| Service | Status | Details |
|---------|--------|---------|
| Caddy | Running/Down | Config valid, {N} routes |
| Redis | Running/Down | Port 9050 |
| Cloud SQL Proxy | Running/Down | Port 9051 |
| k8s Forwards | Healthy/Unhealthy | {N}/{M} forwards alive (HTTP-checked) |

### Active Features
| Feature | Slot | Services | Status |
|---------|------|----------|--------|
| {name} | {N} | backend, frontend | All healthy / Issues |

### Service Health
| Service | Direct | Through Caddy |
|---------|--------|---------------|
| backend | HTTP {code} | HTTP {code} |
| frontend | HTTP {code} | HTTP {code} |

### Resources
| Container | CPU | Memory |
|-----------|-----|--------|
| ... | ...% | .../... |

### Disk
- Images: {size}
- Containers: {size}
- Volumes: {size}
```

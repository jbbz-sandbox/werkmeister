---
name: sandbox-routing-test
description: "Trace a specific URL through the full sandbox routing chain to identify where it breaks. Use when a specific URL isn't working correctly — wrong content, empty response, wrong service handling it, or unexpected redirect. Takes a URL and traces it through every layer: route-config matching, direct service test, Caddy proxy test, and Caddyfile verification."
---

# sandbox-routing-test

Trace a URL through the full routing chain. The user provides a URL (full or relative path). If no URL is provided, ask for one.

## Step 1: Determine Expected Service

Read `cloudflare-workers/shared/routing/route-config.js`. Locate the repo:
use a `cloudflare-workers/` worktree in the current workspace if one exists,
else `${CLOUDFLARE_WORKERS_ROOT:-$HOME/workspace/cloudflare-workers}`.

Match the URL path against the route config rules **in order** to determine which service should handle it.

Derive the feature's host ports from its slot — do NOT assume slot 1. Get the
slot from `sandbox status --json` (each entry in `features` has `slot`; slots
are Docker-label-derived, there is no registry file), then:

```bash
BASE=$((11100 + (SLOT - 1) * 100))   # slot 1 → 11100, slot 2 → 11200, …
```

Service-to-port mapping (offset from `BASE`; offsets are `port_offset` in
`~/.sandbox/services.yaml`, written by `sandbox setup`):
- webV0 → localhost:$BASE
- webV1 → localhost:$((BASE + 1))
- webV2 → localhost:$((BASE + 2))
- mcp → localhost:$((BASE + 11))

## Step 2: Test Direct to Expected Service

```bash
curl -s -D - -o /tmp/sandbox-route-test-direct "http://localhost:{port}{path}" 2>&1 | head -15
```

Report: HTTP status, content-type, content-length/transfer-encoding, any redirects.

## Step 3: Test Through Caddy

The ingress host is configured per machine — never hardcode it. Derive it from
`ingress.local_domain` in `~/.sandbox/config.yaml` plus the routed service name
(`sandbox services <feature>` lists them):

```bash
DOMAIN=$(sed -n 's/^[[:space:]]*local_domain:[[:space:]]*//p' ~/.sandbox/config.yaml | head -1)
BASE="https://${SERVICE}.${DOMAIN}"   # SERVICE = the routed service under test

curl -sk -D - -o /tmp/sandbox-route-test-caddy "${BASE}{path}" 2>&1 | head -15
```

Report: HTTP status, content-type, content-length, server header.

## Step 4: Compare Results

Check for discrepancies:
- **Status mismatch:** Direct returns 200 but Caddy returns different status
- **Empty response:** Caddy returns `content-length: 0` but direct returns content → Caddy routing bug
- **Wrong content:** Different content-type or page content → routed to wrong service
- **Both fail:** Service itself is broken, not a routing issue

## Step 5: Verify Caddy Route Exists

```bash
SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"
grep -n "path.*{relevant_pattern}" "$SANDBOX_ROOT/infra/proxy/Caddyfile"
```

Also check compiled config:

```bash
SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"
docker cp "$SANDBOX_ROOT/infra/proxy/Caddyfile" sandbox-caddy:/tmp/Caddyfile.check
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile.check 2>/dev/null | python3 -c "
import json, sys
config = json.load(sys.stdin)
print(json.dumps(config, indent=2))
" 2>&1 | grep -A2 '{relevant_pattern}'
```

## Step 6: Check Service Logs

If the service itself is returning errors:

```bash
docker logs {container_name} --tail 20 2>&1
```

## Output Format

```
## Route Trace: {url}

**Expected service:** {service} (port {port})
**Routing rule:** {the matching rule from route-config.js}

| Layer | Status | Size | Content-Type |
|-------|--------|------|-------------|
| Direct to {service} | HTTP {code} | {size} | {type} |
| Through Caddy | HTTP {code} | {size} | {type} |

**Verdict:** {PASS: routing correct / FAIL: description of mismatch}
**Root cause:** {if FAIL, explain why}
**Fix:** {if FAIL, provide remediation steps}
```

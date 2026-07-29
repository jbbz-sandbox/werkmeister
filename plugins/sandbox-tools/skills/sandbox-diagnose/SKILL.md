---
name: sandbox-diagnose
description: "Diagnose developer sandbox issues by running comprehensive health checks across all layers: containers, networking, Caddy routing, and service connectivity. Use when a sandbox URL isn't working, returns empty responses, shows wrong content, or any sandbox infrastructure issue is suspected. Also use proactively after `sandbox up` or `sandbox proxy-reload` to verify everything is healthy."
---

# sandbox-diagnose

Run the following diagnostic steps in order. Report findings as a structured summary with PASS/FAIL/WARN for each check.

## Step 1: Baseline Snapshot

Get a structured baseline of all sandbox state in one call:

```bash
sandbox status --json
```

Parse the JSON to identify:
- Any infra service not in `healthy` or `running` state
- Any k8s forward with `status != "alive"` — these now use real HTTP checks, not just TCP
- Any feature with `containers_running < containers_total`
- `summary.infra_healthy` and `summary.k8s_alive` / `summary.k8s_total` counts

If `k8s_forwards` contains dead entries, note the service names and ports for Step 6.

## Step 2: Direct Service Connectivity

Test each running web service directly (bypass Caddy):

Host ports are slot-allocated per feature, so they are never fixed constants —
ask the CLI for the feature's actual endpoints rather than assuming a range:

```bash
sandbox services <feature>
```

Then probe each reported port with its health path from `~/.sandbox/services.yaml`:

```bash
curl -s -o /dev/null -w "<service> (<port>): HTTP %{http_code} | Size: %{size_download}\n" \
  "http://localhost:<port><health_path>" 2>&1
```

Port ranges live in `~/.sandbox/ports.yaml` and service health paths in
`~/.sandbox/services.yaml`; both are written by `sandbox setup` and differ per
machine.

## Step 3: Caddy Routing Verification

Test known URLs through Caddy and compare with direct results:

The ingress host is configured per machine — never hardcode it. It derives from
`ingress.local_domain` in `~/.sandbox/config.yaml` joined to a service that
declares a `feature_router:` block in `~/.sandbox/services.yaml`:

```bash
DOMAIN=$(sed -n 's/^[[:space:]]*local_domain:[[:space:]]*//p' ~/.sandbox/config.yaml | head -1)
SERVICE=next-hello   # the routed service under test; `sandbox services <feature>` lists them
BASE="https://${SERVICE}.${DOMAIN}"

curl -sk -o /dev/null -w "homepage: HTTP %{http_code} | Size: %{size_download}\n" "$BASE/"
```

Then probe the paths that actually matter for this service — the `test_path` in
`.sandbox/workspace.yml`, plus whatever routes the feature touches:

```bash
for path in / "$(sed -n 's/^test_path:[[:space:]]*//p' .sandbox/workspace.yml)"; do
  [ -n "$path" ] || continue
  curl -sk -o /dev/null -w "${path}: HTTP %{http_code} | Size: %{size_download}\n" "${BASE}${path}"
done
```

**Critical:** If any Caddy response has `Size: 0` but the direct service returns content, this indicates a Caddy routing misconfiguration (likely the `handle` vs `route` bug — see CLAUDE.md).

## Step 4: Caddyfile Validation

```bash
SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"
docker cp "$SANDBOX_ROOT/infra/proxy/Caddyfile" sandbox-caddy:/tmp/Caddyfile.check
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile.check 2>/dev/null | \
  node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/dist/lib/caddy.js');
let s=''; for await (const c of process.stdin) s+=c;
console.log('PASS: Caddyfile valid,', countCompiledRoutes(JSON.parse(s)), 'routes compiled');
" 2>&1
```

This reuses the CLI's canonical counter
(`src/lib/caddy.ts::countCompiledRoutes` — one count per `reverse_proxy`
leaf, across **all** compiled servers, same unit `sandbox proxy-reload`
compares). **Expected:** the printed count matches
`grep -c 'reverse_proxy ' "$SANDBOX_ROOT/infra/proxy/Caddyfile"` — there is no
fixed threshold; the number changes with the config. If the compiled count is
**lower** than the grep count, routes are being silently dropped
(handle-vs-route bug).

## Step 5: Network Connectivity from Caddy

```bash
docker exec sandbox-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11100/health 2>&1 && echo "PASS: Caddy -> rest-hello" || echo "FAIL: Caddy -> rest-hello"
docker exec sandbox-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11101/ 2>&1 && echo "PASS: Caddy -> next-hello" || echo "FAIL: Caddy -> next-hello"
```

## Step 6: k8s Port-Forward Detail

If Step 1 flagged any dead k8s forwards, get the full per-service table with HTTP health status:

```bash
sandbox status --k8s
```

This performs real HTTP health checks (not just TCP) against each forward's health endpoint.
Dead entries indicate the forward is TCP-bound but the k8s service isn't responding at the
application layer. The entrypoint's self-healing monitor will restart those forwards within
~45s — check `docker logs sandbox-k8s-forwards` to confirm restart activity.

To check logs for a specific failing service (e.g. next-hello on port 9053):

```bash
docker logs sandbox-k8s-forwards 2>&1 | grep "\[next-hello\]" | tail -20
```

Note: the correct host port for k8s-forwarded services is the `listen_port` from `sandbox status --k8s`
output, **not** the remote k8s pod port. For example, next-hello is at `localhost:9053`,
not `localhost:4321`.

## Step 7: Docker Desktop File Sync

```bash
SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"
HOST_SIZE=$(wc -c < "$SANDBOX_ROOT/infra/proxy/Caddyfile")
CONTAINER_SIZE=$(docker exec sandbox-caddy wc -c < /etc/caddy/Caddyfile 2>/dev/null)
if [ "$HOST_SIZE" = "$CONTAINER_SIZE" ]; then
    echo "PASS: Caddyfile synced ($HOST_SIZE bytes)"
else
    echo "WARN: Caddyfile NOT synced (host: ${HOST_SIZE}B, container: ${CONTAINER_SIZE}B) — use docker cp to force sync"
fi
```

## Output Format

Present results as:

```
## Sandbox Diagnostic Report

| Check | Status | Details |
|-------|--------|---------|
| Container Health | PASS/FAIL | N infra healthy, M features running |
| k8s Forwards | PASS/FAIL | N/M alive (HTTP-checked) |
| rest-hello Direct | PASS/FAIL | HTTP xxx, size |
| next-hello Direct | PASS/FAIL | HTTP xxx, size |
| Caddy → rest-hello | PASS/FAIL | HTTP xxx, size |
| Caddy → next-hello | PASS/FAIL | HTTP xxx, size |
| Caddyfile Valid | PASS/FAIL | N routes compiled |
| Caddyfile Synced | PASS/WARN | host vs container size |
| Network Caddy→backends | PASS/FAIL | per-backend results |
```

If any check fails, provide specific remediation steps.

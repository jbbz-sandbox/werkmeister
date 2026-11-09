# Advanced Troubleshooting Guide

Operational runbook for debugging Werkmeister infrastructure issues.

## Start with the skills

The werkmeister Claude Code plugin runs these checks for you. Ask Claude, or type the command:

| Skill | Use it when | What it does |
|---|---|---|
| `/werkmeister:diagnose` | a workspace URL, container or k8s forward is broken and you don't know why | checks containers, networks, Caddy routing and the forwards, and names the root cause |
| `/werkmeister:routing-test <url>` | one URL returns the wrong page, an empty body or a redirect | traces that URL through each routing layer to the one that breaks |
| `/werkmeister:caddy-reload` | the Caddyfile changed but Caddy still serves the old config | validates the config, counts compiled routes, reloads and smoke-tests |

Without the plugin, `werkmeister infra proxy-reload` and `werkmeister infra status` do the CLI part, and the manual steps below cover the rest.

---

## Manual debugging

When something doesn't work, follow this layered approach:

```
1. Is the container running?           → docker ps
2. Is the service healthy?             → curl localhost:{port}/{health_endpoint}
3. Is Caddy routing correctly?         → curl through Caddy vs direct
4. Is the Caddyfile config correct?    → caddy adapt + count routes
5. Is the network connected?           → wget from inside Caddy container
6. Are k8s forwards working?           → nc -z inside k8s-forwards container
```

Always test **direct to the service first**, then **through Caddy**. If direct works but Caddy doesn't, it's a routing/proxy issue. If direct fails too, it's a service issue.

---

## Blank Pages / Empty Responses (content-length: 0)

This is the most common infrastructure issue.

### Quick Diagnosis

```bash
# Test through Caddy
curl -sk -o /dev/null -w "Caddy: HTTP %{http_code} | Size: %{size_download}\n" \
  "https://frontend.local.werkmeister.io/your/path"

# Test direct to expected service (check CLAUDE.md routing table for correct port)
curl -s -o /dev/null -w "Direct: HTTP %{http_code} | Size: %{size_download}\n" \
  "http://localhost:11102/your/path"
```

### If Caddy returns Size: 0 but Direct works

**Cause:** Caddy routing misconfiguration — the route for this path was silently dropped.

**Verify** (read-only: it leaves the live config alone):
```bash
docker cp ~/.werkmeister/infra/proxy/Caddyfile w9r-caddy:/tmp/Caddyfile
```

Then count the routes as in [Count Compiled Routes](#count-compiled-routes).

**Fix:** The generated Caddyfile uses scoped `handle @<feature>` blocks; a bare `handle` beside scoped ones is what drops routes. Regenerate it (`werkmeister infra proxy-reload`) rather than hand-editing it.

### If Both Return Empty/Error

Check service logs:
```bash
docker logs {feature}-{service} --tail 50 2>&1
```

Common causes:
- Service crashed during startup (check for Node.js OOM or missing env vars)
- Database connection failed (check the postgres/redis k8s forwards)
- Missing dependencies (setup service didn't complete)

---

## Container Won't Start or Keeps Restarting

### Check Logs
```bash
docker logs {container_name} --tail 100 2>&1
```

### Common Causes

| Error | Cause | Fix |
|-------|-------|-----|
| `ECONNREFUSED` to database | postgres forward not ready | `docker restart w9r-k8s-forwards` or check k8s forwards |
| `yarn: command not found` | Bad Docker image or missing node_modules volume | `werkmeister feature down --volumes && werkmeister feature up` |
| OOM Killed | Container exceeded memory limit | Increase `memory_limit` in the repo's `.werkmeister/services.yaml` |
| Port already in use | Another process using the port | `lsof -i :{port}` to find the conflict |
| `ENOSPC` | Docker disk full | `docker system prune -a` |

### Check Resource Limits
```bash
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" | sort -k3 -rh
```

---

## k8s Port-Forward Issues

### Check Overall Health
```bash
docker inspect w9r-k8s-forwards --format '{{.State.Health.Status}}'
docker logs w9r-k8s-forwards --tail 30 2>&1
```

### Test Individual Forwards

`werkmeister infra status` probes each forward with its own health check. By hand, with the ports from [k8s Forward Ports](configuration.md#k8s-forward-ports):

```bash
docker exec w9r-k8s-forwards sh -c '
for p in 9050 9051 9052 9053; do
    if nc -z localhost $p 2>/dev/null; then echo "UP:   port $p"
    else echo "DOWN: port $p"; fi
done'
```

### Restart Forwards
```bash
docker restart w9r-k8s-forwards
# Wait for health check (start_period is 60s)
sleep 65
docker inspect w9r-k8s-forwards --format '{{.State.Health.Status}}'
```

### k8s Auth Issues
If forwards fail to connect:
```bash
# Check the cluster answers with the context Werkmeister uses
kubectl config current-context
kubectl get nodes >/dev/null 2>&1 && echo "Cluster OK" || echo "Cluster unreachable"

# The container reads the generated kubeconfig, not your live one —
# `werkmeister infra connect` regenerates it (rewriting the API server to
# host.docker.internal so it resolves from inside the container).
werkmeister infra connect

# Restart forwards afterwards
docker restart w9r-k8s-forwards
```

---

## Caddy Configuration Issues

### Validate Config
```bash
docker cp ~/.werkmeister/infra/proxy/Caddyfile w9r-caddy:/tmp/Caddyfile
docker exec w9r-caddy caddy adapt --config /tmp/Caddyfile 2>&1
```

### Reload After Changes
```bash
# ALWAYS use docker cp — do NOT rely on bind mount sync
docker cp ~/.werkmeister/infra/proxy/Caddyfile w9r-caddy:/tmp/Caddyfile
docker exec w9r-caddy caddy reload --config /tmp/Caddyfile
```

### Count Compiled Routes

`werkmeister infra proxy-reload` counts them and refuses a drop. By hand, after the `docker cp` above (the same walk the CLI and the caddy-reload skill use, one count per `reverse_proxy`):

```bash
docker exec w9r-caddy caddy adapt --config /tmp/Caddyfile 2>/dev/null | \
  node --input-type=module -e "
let s=''; for await (const c of process.stdin) s+=c;
const walk=(rs=[])=>rs.reduce((n,r)=>n+(r.handle??[]).reduce((m,h)=>m+(h.handler==='subroute'?walk(h.routes):h.handler==='reverse_proxy'?1:0),0),0);
const servers=JSON.parse(s).apps?.http?.servers??{};
console.log('Compiled routes:', Object.values(servers).reduce((n,sv)=>n+walk(sv.routes),0));
"
grep -v '^\s*#' ~/.werkmeister/infra/proxy/Caddyfile | grep -c '\breverse_proxy\b'
```

**Expected:** the compiled count is at least the grep count. Fewer compiled routes means some were dropped, usually by a bare `handle` beside scoped ones.

### Check TLS Certificates
```bash
ls -la ~/.docker/certs/
openssl x509 -in ~/.docker/certs/localhost.crt -noout -dates 2>/dev/null
```

---

## Network Connectivity Issues

### Caddy to Backend Services
```bash
# Test from inside Caddy container
docker exec w9r-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11100/ 2>&1
docker exec w9r-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11101/ 2>&1
docker exec w9r-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11102/api/healthcheck 2>&1
```

### Docker Network Inspection
```bash
# Check which networks exist
docker network ls --filter name=werkmeister

# Check which containers are on each network
docker network inspect w9r-infra_default --format '{{range .Containers}}{{.Name}} {{end}}'
docker network inspect werkmeister-shared --format '{{range .Containers}}{{.Name}} {{end}}'
```

### DNS Resolution Inside Containers
```bash
docker exec w9r-caddy nslookup host.docker.internal
docker exec {feature}-frontend nslookup k8s-forwards
```

---

## Common errors

### "No available slots" Error

Every slot is taken (12 by default). Free one by stopping a feature:

```bash
werkmeister feature status          # See which features are active
werkmeister feature down old-feature  # Free up a slot
```

### Services Not Auto-Detected

```bash
# Check that the workspace has committed changes
cd ~/workspace/PROJ-1234/werkmeister
git diff main..HEAD --name-only

# Verify repo name matches config
grep -A 3 "repos:" ~/.werkmeister/services.yaml

# Add the service manually: list it in `services` in .werkmeister/workspace.yml, then
werkmeister workspace init
werkmeister feature up PROJ-1234
```

### Build/Dependency Errors

```bash
# Reinstall dependencies and rebuild the CLI
rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/cli/dist
pnpm install
pnpm turbo run build --filter=werkmeister
werkmeister --help

# Check the node version — must be 20+
node --version

# werkmeister picks a runtime: WERKMEISTER_NODE, then PATH, then the newest nvm
# install. Pin it explicitly if the wrong one is found:
WERKMEISTER_NODE=/opt/homebrew/bin/node werkmeister --help

# Update a dependency
#   1. Edit the version in apps/cli/package.json
#   2. pnpm install   # re-resolve and update pnpm-lock.yaml
#   3. pnpm turbo run build --filter=werkmeister
```

> `werkmeister internal gate` deliberately bypasses the CLI import chain via
> `dist/lib/gate.js` for a fast PreToolUse cold start — if the gate misbehaves,
> confirm `dist/` is built before debugging further.

### Stale Slot Data

If `~/.werkmeister/slots.json` gets out of sync (e.g., containers were removed manually):

```bash
# View current slot data
cat ~/.werkmeister/slots.json | jq .

# Reset by running down on stale features
werkmeister feature down stale-feature

# Or manually edit the file
# (delete entries for features that no longer exist)
```


---

## Full System Recovery

When everything is broken:

```bash
# 1. Stop all feature services
werkmeister feature down --all-features

# 2. Restart shared infrastructure (Caddy, k8s forwards)
werkmeister infra restart

# 3. Check infrastructure health
werkmeister infra status

# 4. Re-start your feature
werkmeister feature up {feature}

# 5. Verify
werkmeister feature status
```

### Nuclear Option (full reset)

```bash
# Stop everything
werkmeister feature down --all-features --volumes
werkmeister infra down --volumes

# Clean up
docker system prune -a --volumes  # WARNING: removes ALL unused Docker resources

# Start fresh
werkmeister infra up
werkmeister feature up {feature}
```

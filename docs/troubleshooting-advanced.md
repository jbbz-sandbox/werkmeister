# Advanced Troubleshooting Guide

Operational runbook for debugging Werkmeister infrastructure issues that go beyond the basic troubleshooting in the users guide.

---

## Debugging Framework

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

**Verify:**
```bash
docker cp ~/.werkmeister/infra/proxy/Caddyfile w9r-caddy:/tmp/Caddyfile
docker exec w9r-caddy caddy adapt --config /tmp/Caddyfile 2>&1 | \
  node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/../../packages/werkmeister-core/dist/caddy.js');
const json = await new Response(process.stdin).text();
console.log(countCompiledRoutes(JSON.parse(json)), 'compiled routes');
"
```

> Needs `pnpm --filter werkmeister-core run build` first — `dist/` is gitignored.

**Fix:** Ensure the Caddyfile uses `route { ... }` instead of multiple `handle` blocks. See `docs/known-issues.md` for the full explanation.

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
| `yarn: command not found` | Bad Docker image or missing node_modules volume | `werkmeister down --volumes && werkmeister up` |
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
```bash
docker exec w9r-k8s-forwards sh -c '
for p in 9000 9001 9002 9003 9004 9005 9006 9007 9008 9052; do
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
# `werkmeister connect` regenerates it (rewriting the API server to
# host.docker.internal so it resolves from inside the container).
werkmeister connect

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
```bash
docker exec w9r-caddy caddy adapt --config /tmp/Caddyfile 2>/dev/null | \
  node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/../../packages/werkmeister-core/dist/caddy.js');
const total = countCompiledRoutes(JSON.parse(await new Response(process.stdin).text()));
console.log('Total compiled routes:', total);
if (total < 15) console.log('WARNING: Routes may have been silently dropped!');
"
```

**Expected:** 20+ routes for a standard Werkmeister setup. Under 15 means the `handle` vs `route` bug.

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
docker network ls --filter name=sandbox

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

## Service-Specific Issues

### frontend (demo-services/apps/frontend)

**Next.js build errors:** Check if the repo's setup service (if any) completed:
```bash
docker logs {feature}-demo-services-setup --tail 20 2>&1
```

**API errors in frontend logs:** Usually means an upstream service isn't reachable. Check environment variable resolution:
```bash
docker exec {feature}-frontend env | grep -E "_URL"
```

### GraphQL gateway (if your registry defines one)

**Subgraph connection errors:** Check that every dependent subgraph is running and accessible:
```bash
docker exec {feature}-<gateway> wget -q -O /dev/null http://<subgraph>:<port>/graphql 2>&1
```

---

## Full System Recovery

When everything is broken:

```bash
# 1. Stop all feature services
werkmeister down --all-features

# 2. Restart shared infrastructure
cd "$SANDBOX_ROOT"
docker compose -f infra/compose/shared-infra.yml down
docker compose -f infra/compose/shared-infra.yml up -d

# 3. Wait for infrastructure health
sleep 30
docker ps --format "table {{.Names}}\t{{.Status}}" | grep sandbox

# 4. Re-start your feature
werkmeister up {feature}

# 5. Verify
werkmeister status
```

### Nuclear Option (full reset)

```bash
# Stop everything
werkmeister down --all-features --volumes
docker compose -f infra/compose/shared-infra.yml down -v

# Clean up
docker system prune -a --volumes  # WARNING: removes ALL unused Docker resources

# Start fresh
docker compose -f infra/compose/shared-infra.yml up -d
werkmeister up {feature}
```

## Canonical test URLs

Known-good URLs for each web tier (salvaged from the retired `~/workspace/CLAUDE.md`;
routing source of truth is the `feature_router:` blocks in `~/.werkmeister/services.yaml`):

```
# frontend (web)
https://frontend.local.werkmeister.io/
https://frontend.local.werkmeister.io/__werkmeister

# backend (api)
https://backend.local.werkmeister.io/health
```

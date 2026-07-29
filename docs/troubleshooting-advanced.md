# Advanced Troubleshooting Guide

Operational runbook for debugging developer sandbox infrastructure issues that go beyond the basic troubleshooting in the users guide.

---

## Debugging Framework

When something doesn't work, follow this layered approach:

```
1. Is the container running?           → docker ps
2. Is the service healthy?             → curl localhost:{port}/{health_endpoint}
3. Is Caddy routing correctly?         → curl through Caddy vs direct
4. Is the Caddyfile config correct?    → caddy adapt + count routes
5. Is the network connected?           → wget from inside Caddy container
6. Are GKE forwards working?           → nc -z inside gke-forwards container
```

Always test **direct to the service first**, then **through Caddy**. If direct works but Caddy doesn't, it's a routing/proxy issue. If direct fails too, it's a service issue.

---

## Blank Pages / Empty Responses (content-length: 0)

This is the most common infrastructure issue.

### Quick Diagnosis

```bash
# Test through Caddy
curl -sk -o /dev/null -w "Caddy: HTTP %{http_code} | Size: %{size_download}\n" \
  "https://sb-web.local.sandbox.com/your/path"

# Test direct to expected service (check CLAUDE.md routing table for correct port)
curl -s -o /dev/null -w "Direct: HTTP %{http_code} | Size: %{size_download}\n" \
  "http://localhost:11102/your/path"
```

### If Caddy returns Size: 0 but Direct works

**Cause:** Caddy routing misconfiguration — the route for this path was silently dropped.

**Verify:**
```bash
docker cp infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile 2>&1 | \
  node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/dist/lib/caddy.js');
const json = await new Response(process.stdin).text();
console.log(countCompiledRoutes(JSON.parse(json)), 'compiled routes');
"
```

> Needs `npm --prefix apps/cli run build` first — `dist/` is gitignored.

**Fix:** Ensure the Caddyfile uses `route { ... }` instead of multiple `handle` blocks. See `docs/known-issues.md` for the full explanation.

### If Both Return Empty/Error

Check service logs:
```bash
docker logs {feature}-{service} --tail 50 2>&1
```

Common causes:
- Service crashed during startup (check for Node.js OOM or missing env vars)
- Database connection failed (check cloud-sql-proxy and mongodb GKE forward)
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
| `ECONNREFUSED` to database | cloud-sql-proxy or mongodb not ready | `docker restart sandbox-cloud-sql-proxy` or check GKE forwards |
| `yarn: command not found` | Bad Docker image or missing node_modules volume | `sandbox down --volumes && sandbox up` |
| OOM Killed | Container exceeded memory limit | Increase `memory_limit` in `infra/config/services.yaml` |
| Port already in use | Another process using the port | `lsof -i :{port}` to find the conflict |
| `ENOSPC` | Docker disk full | `docker system prune -a` |

### Check Resource Limits
```bash
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" | sort -k3 -rh
```

---

## GKE Port-Forward Issues

### Check Overall Health
```bash
docker inspect sandbox-gke-forwards --format '{{.State.Health.Status}}'
docker logs sandbox-gke-forwards --tail 30 2>&1
```

### Test Individual Forwards
```bash
docker exec sandbox-gke-forwards sh -c '
for p in 9000 9001 9002 9003 9004 9005 9006 9007 9008 9052; do
    if nc -z localhost $p 2>/dev/null; then echo "UP:   port $p"
    else echo "DOWN: port $p"; fi
done'
```

### Restart Forwards
```bash
docker restart sandbox-gke-forwards
# Wait for health check (start_period is 60s)
sleep 65
docker inspect sandbox-gke-forwards --format '{{.State.Health.Status}}'
```

### GKE Auth Issues
If forwards fail to connect:
```bash
# Check GKE credentials
gcloud auth application-default print-access-token >/dev/null 2>&1 && echo "Auth OK" || echo "Auth expired"

# Re-authenticate
gcloud auth application-default login
gcloud container clusters get-credentials tr-dev --region us-central1 --project tr-dev-361214

# Restart forwards after re-auth
docker restart sandbox-gke-forwards
```

---

## Caddy Configuration Issues

### Validate Config
```bash
docker cp infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile 2>&1
```

### Reload After Changes
```bash
# ALWAYS use docker cp — do NOT rely on bind mount sync
docker cp infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile
docker exec sandbox-caddy caddy reload --config /tmp/Caddyfile
```

### Count Compiled Routes
```bash
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile 2>/dev/null | \
  node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/dist/lib/caddy.js');
const total = countCompiledRoutes(JSON.parse(await new Response(process.stdin).text()));
console.log('Total compiled routes:', total);
if (total < 15) console.log('WARNING: Routes may have been silently dropped!');
"
```

**Expected:** 20+ routes for a standard sandbox. Under 15 means the `handle` vs `route` bug.

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
docker exec sandbox-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11100/ 2>&1
docker exec sandbox-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11101/ 2>&1
docker exec sandbox-caddy wget -q -O /dev/null --timeout=3 http://host.docker.internal:11102/api/healthcheck 2>&1
```

### Docker Network Inspection
```bash
# Check which networks exist
docker network ls --filter name=sandbox

# Check which containers are on each network
docker network inspect sandbox-infra_default --format '{{range .Containers}}{{.Name}} {{end}}'
docker network inspect sandbox-shared --format '{{range .Containers}}{{.Name}} {{end}}'
```

### DNS Resolution Inside Containers
```bash
docker exec sandbox-caddy nslookup host.docker.internal
docker exec {feature}-web-v2 nslookup gke-forwards
```

---

## Service-Specific Issues

### web-v2 (econx/apps/web-v2)

**Next.js build errors:** Check if the setup service completed:
```bash
docker logs {feature}-econx-setup --tail 20 2>&1
```

**API errors in web-v2 logs:** Usually means sb-web-api, category-api, or product-api aren't reachable. Check environment variable resolution:
```bash
docker exec {feature}-web-v2 env | grep -E "API_URL|GRAPHQL_URL"
```

### web-v1 (sb-web)

**Auth0 errors:** Check that Auth0 secrets are set in `~/.sandbox/secrets.env`:
```bash
grep -c "AUTH0" ~/.sandbox/secrets.env
```

### federated-graph

**Subgraph connection errors:** Check that all dependent services (product-api, category-api, interview-api) are running and accessible:
```bash
docker exec {feature}-federated-graph wget -q -O /dev/null http://product-api:3333/graphql 2>&1
```

---

## Full System Recovery

When everything is broken:

```bash
# 1. Stop all feature services
sandbox down --all

# 2. Restart shared infrastructure
cd /Users/jayboyer/workspace/sandbox
docker compose -f infra/compose/shared-infra.yml down
docker compose -f infra/compose/shared-infra.yml up -d

# 3. Wait for infrastructure health
sleep 30
docker ps --format "table {{.Names}}\t{{.Status}}" | grep sandbox

# 4. Re-start your feature
sandbox up {feature}

# 5. Verify
sandbox status
```

### Nuclear Option (full reset)

```bash
# Stop everything
sandbox down --all --volumes
docker compose -f infra/compose/shared-infra.yml down -v

# Clean up
docker system prune -a --volumes  # WARNING: removes ALL unused Docker resources

# Start fresh
docker compose -f infra/compose/shared-infra.yml up -d
sandbox up {feature}
```

## Canonical test URLs

Known-good URLs for each web tier (salvaged from the retired `~/workspace/CLAUDE.md`;
routing source of truth is `cloudflare-workers/shared/routing/route-config.js`):

```
# web-v2
https://sb-web.local.sandbox.com/categories/crm
https://sb-web.local.sandbox.com/products/sap-sales-performance-management/pricing
https://sb-web.local.sandbox.com/products/sap-sales-performance-management/reviews/all

# web-v1
https://sb-web.local.sandbox.com/
https://sb-web.local.sandbox.com/products/sap-sales-performance-management/reviews

# web-v0
https://sb-web.local.sandbox.com/compare-products/sap-sales-performance-management-vs-xactly-incent
https://sb-web.local.sandbox.com/products/sap-sales-performance-management/competitors
```

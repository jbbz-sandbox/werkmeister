---
name: caddy-reload
description: "Safely reload the Caddy proxy configuration with validation and smoke testing. Use after editing ~/.werkmeister/infra/proxy/Caddyfile, after running `sandbox proxy-reload`, or when the Caddyfile on disk has been updated but Caddy is still serving old config. Validates config, counts compiled routes to detect silent drops, reloads, and smoke tests key URLs."
---

# caddy-reload

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

Safely reload Caddy with validation and smoke tests.

## Step 0: Prefer `sandbox proxy-reload` (primary path)

`sandbox proxy-reload` runs a CLI-native pipeline internally
(`werkmeister-core/caddy.ts::reloadCaddy`) that already does the
`docker cp` -> structural lint (advisory) -> `caddy adapt` (validates AND
yields the compiled route count in one call) -> compare against a
config-derived expected count -> `caddy reload` sequence, and it fails loudly
with specific diagnostics (which counts it compared, or the adapt error) if
anything is wrong -- it never reloads a config with a route-count drop or a
failed adapt.

**Your first move for "Caddyfile changed, need to reload" should be:**

```bash
sandbox proxy-reload
```

Read its output. If it reports success, you're done -- skip the rest of this
skill. If it reports a route-count drop or an adapt failure, it already named
the problem; go fix the Caddyfile (see the handle-vs-route gotcha in
`CLAUDE.md`) and re-run `sandbox proxy-reload`, rather than falling through to
the manual steps below.

Only use the manual procedure below (Steps 1-5) when `sandbox proxy-reload`
itself is broken or unavailable -- e.g. a CLI bug, or you need to push and
reload a hand-edited Caddyfile outside the generator. This manual path stays
independent of the reload *pipeline* (`reloadCaddy`), but the route counting
in Step 2 reuses the CLI's pure counting function so both always agree on the
number.

## Step 1: Validate the Caddyfile

Copy into container (avoids Docker Desktop VirtioFS sync lag) and validate.
This uses `/tmp/Caddyfile.new` rather than the CLI's `/tmp/Caddyfile` path
specifically so a manual reload never collides with a concurrently running
`sandbox proxy-reload` (which owns `/tmp/Caddyfile`):

```bash
CFG="${WERKMEISTER_CONFIG_FILE:-${SANDBOX_CONFIG_FILE:-$(for d in .werkmeister .sandbox; do [ -d "$HOME/$d" ] && echo "$HOME/$d/config.yaml" && break; done)}}"
CADDYFILE="$(dirname "$CFG")/infra/proxy/Caddyfile"
docker cp "$CADDYFILE" sandbox-caddy:/tmp/Caddyfile.new
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile.new 2>&1
```

If output contains `Error:`, STOP and report. Do not reload an invalid config.

## Step 2: Count Compiled Routes

```bash
docker exec sandbox-caddy caddy adapt --config /tmp/Caddyfile.new 2>/dev/null | \
  node --input-type=module -e "
let s=''; for await (const c of process.stdin) s+=c;
const walk=(rs=[])=>rs.reduce((n,r)=>n+(r.handle??[]).reduce((m,h)=>m+(h.handler==='subroute'?walk(h.routes):h.handler==='reverse_proxy'?1:0),0),0);
const servers=JSON.parse(s).apps?.http?.servers??{};
console.log('Compiled routes:', Object.values(servers).reduce((n,sv)=>n+walk(sv.routes),0));
"
```

This mirrors the CLI's canonical counter
(`werkmeister-core/caddy.ts::countCompiledRoutes` — one count per `reverse_proxy`
leaf, across **all** compiled servers, not just `srv0`), so the manual path
and `sandbox proxy-reload` agree on the number. The CLI ships as one bundle
with no importable `dist/lib/caddy.js`, so the walk is inlined here.

**Expected:** compare the printed compiled count against the number of
`reverse_proxy` occurrences in the Caddyfile you just copied in
(`grep -c 'reverse_proxy ' "$CADDYFILE"`). These two
numbers count the same thing (distinct `reverse_proxy` destinations) and
should match on a healthy config -- the same config-derived comparison
`computeExpectedRouteCount()` performs in the CLI. There is no fixed
threshold: a fresh generation of the current `~/.werkmeister/infra/proxy/Caddyfile` compiles to
7 routes, and that number changes whenever site blocks or `reverse_proxy`
directives are added or removed. If the compiled count is **lower** than the
`reverse_proxy` occurrence count in the source file, routes were silently
dropped (the historic handle-vs-route bug, or a duplicate/overlapping
`handle` matcher) -- warn the user and do NOT reload.

## Step 3: Reload Caddy

```bash
docker exec sandbox-caddy caddy reload --config /tmp/Caddyfile.new 2>&1
```

## Step 4: Smoke Test Routes

The ingress host is configured per machine — never hardcode it. Derive it from
`ingress.local_domain` in `~/.werkmeister/config.yaml` plus the routed service name:

```bash
DOMAIN=$(sed -n 's/^[[:space:]]*local_domain:[[:space:]]*//p' ~/.werkmeister/config.yaml ~/.sandbox/config.yaml 2>/dev/null | head -1)
SERVICE=frontend   # the routed service under test; `sandbox services <feature>` lists them
BASE="https://${SERVICE}.${DOMAIN}"

curl -sk -o /dev/null -w "homepage: HTTP %{http_code} | Size: %{size_download}\n" "$BASE/"
```

Smoke-test every hostname the reload affects, not just one — `sandbox services
<feature>` lists the routed endpoints for the feature you just reloaded.

**Critical:** Any `Size: 0` when the service is known healthy means the reload introduced a routing bug. Report immediately.

## Step 5: Verify File Sync

```bash
CFG="${WERKMEISTER_CONFIG_FILE:-${SANDBOX_CONFIG_FILE:-$(for d in .werkmeister .sandbox; do [ -d "$HOME/$d" ] && echo "$HOME/$d/config.yaml" && break; done)}}"
CADDYFILE="$(dirname "$CFG")/infra/proxy/Caddyfile"
HOST_SIZE=$(wc -c < "$CADDYFILE" | tr -d " ")  # macOS wc pads the count with spaces
CONTAINER_SIZE=$(docker exec sandbox-caddy wc -c /etc/caddy/Caddyfile 2>/dev/null | awk '{print $1}')  # path given to wc in the container; a < redirect reads the host file
echo "Host: ${HOST_SIZE} bytes, Container bind-mount: ${CONTAINER_SIZE} bytes"
if [ "$HOST_SIZE" != "$CONTAINER_SIZE" ]; then
    echo "NOTE: Bind-mount not synced yet. This is normal with Docker Desktop."
    echo "Caddy is using the config loaded via /tmp/Caddyfile.new which is correct."
fi
```

## Output Format

```
## Caddy Reload Results

| Step | Status |
|------|--------|
| Validation | PASS/FAIL |
| Route count | {N} compiled vs {M} reverse_proxy in source (PASS if N >= M) |
| Reload | PASS/FAIL |
| Smoke: homepage (v1) | HTTP {code}, {size} bytes |
| Smoke: pricing (v2) | HTTP {code}, {size} bytes |
| Smoke: catch-all (v0) | HTTP {code}, {size} bytes |
| File sync | Synced / Using docker cp |
```

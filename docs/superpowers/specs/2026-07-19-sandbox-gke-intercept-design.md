# Spec: `sandbox intercept` — live testing in the GKE dev cluster

**Date:** 2026-07-19
**Status:** Draft — pending Jay's review of options + open questions
**Scope:** Additive capability. The existing docker-compose path (`init-workspace` → `up` → Caddy/worker routing → gke-forwards) is **unchanged and out of scope**.

---

## 1. Problem

Today a feature workspace tests services only through the local sandbox: Caddy +
tr-proxy route `X-Feature` traffic to local containers, and everything else falls
through to GKE via the containerized `kubectl port-forward`s (`gke-forwards`).
That validates a service against *forwarded* GKE dependencies, but never puts the
service **inside** the dev environment: real ingress, real Istio ambient mesh,
real service-to-service calls, real env/secrets, real data paths at
`gke_tr-dev-361214_us-central1_tr-dev-gke`.

Goal: a developer runs a modified service locally and has it serve (a scoped
slice of) live traffic in the dev cluster — without redeploying, and without
breaking the other ~11 developers sharing that cluster.

## 2. Current-command review (integration points)

Reviewed `apps/cli/src/commands/init_workspace.ts` and `apps/cli/src/commands/up.ts` (2026-07-19,
branch `multi-feature`). Verified:

- **`init-workspace`** is config-driven and idempotent: resolves inputs
  (CLI > `SANDBOX_*` env > `.sandbox/workspace.yml` > existing `.env`),
  reconciles per-repo worktrees, generates CLAUDE.md / `.env` /
  `docker-compose.yml` / skills / agents / standards manifest. Compose
  generation is an isolated step (step 8) gated on `FEATURE` — an additional
  runtime mode does not perturb the rest of the pipeline.
- **`up`** allocates a slot, regenerates compose/env/supergraph on slot change,
  health-checks `gke-forwards`, `compose up`s local services, regenerates Caddy +
  worker env. All routing is **inbound through the local proxy**; the cluster
  never initiates traffic toward the laptop.
- **`infra/config/services.yaml` already carries the cluster coordinates an
  interception tool needs per service**: `gke_deployment`, `gke_namespace`,
  `gke_port`, `gke_pod_prefix` (verified for web-v0/v1/v2, product-api,
  category-api, federated-graph, etc.). No new registry is required — only,
  possibly, one new optional key (§6.2).
- Local services are published to the host at slot-offset ports
  (`get_service_port(slot, port_offset)`, base 11100 + (slot−1)·100). An
  intercept can forward cluster traffic to that **same host port**, reusing the
  compose-run container (with its hot-reload mounts) as the intercept target.

Conclusion: the new capability composes cleanly as a **new subcommand + one lib
module**, consuming existing `services.yaml` metadata and the existing slot
ports. No changes to `init-workspace`, `up`, templates, or Caddy.

## 3. Research summary (2026-07-19)

Full comparison was researched against current releases and issue trackers;
key claims below are **Verified** against the cited sources unless tagged.

### Option A — Telepresence OSS (CNCF, Apache 2.0) · recommended

- v2.30.1 (2026-07-17). The commercial tier was folded into Ambassador's
  Blackbird (Mar 2025); **header-filtered intercepts are now fully in the free
  CNCF build** (since 2.25, Oct 2025) — the historical "personal intercepts are
  paid" gate is gone. ([release notes](https://telepresence.io/docs/release-notes),
  [intercepts](https://telepresence.io/docs/concepts/intercepts))
- Modes: `intercept` (reroute matching requests to laptop), `wiretap` (copy),
  `replace`, `ingest`. Header filters (`--http-header x-feature=<feature>`)
  scope interception per developer on a shared cluster — the documented
  team-shared-cluster pattern, and a 1:1 match for our existing `X-Feature`
  convention.
- Outbound: `telepresence connect` gives the laptop cluster DNS + routed access
  (utun VIF), so the local process can call `http://svc.namespace:port` directly.
- **Istio ambient**: intercepts break if the traffic-agent falls back to
  init-container iptables (conflicts with ztunnel in-pod rules) —
  [telepresenceio#3990](https://github.com/telepresenceio/telepresence/issues/3990),
  closed completed 2025-11 with the fix: **named `containerPort` + Service
  `targetPort` by name** → agent hijacks by port rename, no iptables. Ambient
  manager-restart bug fixed in 2.29.x
  ([#4095](https://github.com/telepresenceio/telepresence/issues/4095)).
- Cluster footprint: one Helm-installed `traffic-manager` Deployment (no CRDs;
  namespace-scoped install possible with Role/RoleBinding only), traffic-agents
  injected by mutating webhook. GKE private clusters need a firewall rule for
  webhook port 8443. (Inferred: tr-dev-gke's private-cluster status must be
  checked — §8.)
- macOS: root daemon for the VIF (one-time launchd installer since 2.27);
  FUSE-T for volume mounts; VPN conflicts handled via VNAT or avoided entirely
  with `telepresence connect --docker`.
- **Cost: $0 for all 12 devs.**

### Option B — mirrord (MetalBear, MIT core + paid operator)

- v3.234.0 (2026-07-17). Cleanest client story: no root, no VIF, no VPN
  interaction; per-session agent pod in the target's namespaces, zero standing
  cluster install. HTTP header steal-filter is free.
- **Istio ambient**: supported since 3.113.0, but requires
  `"agent": {"privileged": true}` (sets `route_localnet=1` in the target netns)
  — [metalbear-co/mirrord#2456](https://github.com/metalbear-co/mirrord/issues/2456).
  So every dev needs RBAC to create privileged pods in service namespaces.
- **Shared-cluster gap**: OSS does not coordinate concurrent sessions against
  the same target; conflict-free concurrency, HTTPS steal, policies, and
  no-privileged-RBAC all live in the paid operator — **$40/seat/mo ≈ $480/mo
  for 12 devs** ([pricing](https://metalbear.com/mirrord/pricing/)).

### Option C — DIY Istio ambient routing

Waypoint + `HTTPRoute` steering `x-feature: <dev>` to a stand-in Service backed
by a laptop tunnel (consistent with the workspace decision that ambient L7
routing uses waypoint + HTTPRoute, not VirtualService). Zero license cost,
maximal control — but rebuilds Telepresence's agent/tunnel/DNS/env story by
hand. Rejected as primary path; noted as fallback if tool adoption is blocked.

Also considered and rejected: **Gefyra** (carrier replaces the serving
container — unsafe on a shared cluster; ambient undocumented), **kubefwd**
(outbound-only; already covered by `gke-forwards`), **Signadot** (good shared-
cluster model but SaaS control plane + sidecar-era Istio story), **Okteto/
DevSpace sync-swap** (whole-workload takeover), **ktunnel** (no per-dev
scoping, lightly maintained).

## 4. Recommendation

**Telepresence OSS 2.30.x, `intercept` mode with `--http-header
x-feature=<feature>` filters.** Rationale:

1. $0 and Apache-2.0/CNCF — no per-seat procurement for 12 devs.
2. Header-scoped intercepts are exactly the sandbox's existing `X-Feature`
   routing identity, extended from the local proxy into the real cluster.
3. Safe multi-dev concurrency is in the free tier (mirrord needs the paid
   operator for the same guarantee).
4. Ambient compatibility has a maintainer-confirmed, low-cost precondition
   (named targetPorts) rather than privileged-pod RBAC for every developer.

mirrord OSS remains the fallback if the traffic-manager install or the macOS
root daemon proves unacceptable — the CLI design below isolates the tool behind
one lib module so the backend could be swapped.

## 5. Design overview

New command, additive; compose path untouched.

```
sandbox intercept <feature> -s <service> [--mode intercept|wiretap|replace] [--port N]
sandbox intercept <feature> --leave [-s <service>]
sandbox intercept --status
```

Flow for `sandbox intercept my-feat -s product-api`:

1. Resolve workspace + feature exactly as `up` does (`resolve_workspace`,
   `.env` `SERVICES`/`SANDBOX_SLOT`). Require the service to be one of the
   workspace's local services **and already running** via `sandbox up`
   (the compose container on its slot host port is the intercept target —
   hot-reload keeps working, and we add no second way to run a service).
2. Look up `gke_deployment` / `gke_namespace` / `gke_port` from
   `services.yaml`; refuse services without them.
3. Ensure `telepresence connect` (kube-context pinned to
   `gke_tr-dev-361214_us-central1_tr-dev-gke`, namespace from the service).
   Use `--docker` connect mode by default (daemon in a container — avoids the
   host VIF fighting VPNs/Docker Desktop; falls back to host mode via flag).
4. Run
   `telepresence intercept <gke_deployment> --port <slot_host_port>:<named_port>
   --http-header x-feature=<feature> --mounts false`.
5. Print how to exercise it: hit the **dev environment URL** with the
   `X-Feature: <feature>` header/cookie (or `sandbox open --dev <feature>`,
   a later enhancement reusing `apps/cli/src/lib/browser.ts`'s cookie injection).
6. `--leave` runs `telepresence leave`; `sandbox down` also calls it so
   teardown can't leave an intercept dangling. `--status` shells to
   `telepresence status`/`list` and folds into `sandbox status` later.

Implementation shape (conventions-compliant):

- `apps/cli/src/commands/intercept.ts` — one file per subcommand.
- `apps/cli/src/lib/telepresence.ts` — subprocess wrappers
  (connect/intercept/leave/status/version-check), all cluster coordinates read
  from `services.yaml` via existing loaders. No hardcoded service names/ports.
- `sandbox down` gains a best-effort `leave_all(feature)` call (warn-only).
- `sandbox setup` gains a telepresence brew-install/version check alongside the
  existing prereqs.

Estimated size: ~2 new files + 2 small touches; no template or compose changes.

## 6. Cluster-side prerequisites (platform work, one-time)

### 6.1 traffic-manager install

`telepresence helm install` into the dev cluster — decide cluster-wide vs
namespace-scoped (`namespaces:` values). Namespace-scoped with the ~13 service
namespaces from `services.yaml` (`sandbox`, `web-v2`, `product`, `category`,
`federated-graph`, `vendor-portal`, `taxonomy-service`, `interview-service`,
`award-service`, `user-service`, `sandbox-mcp`, …) needs only
Role/RoleBindings. If tr-dev-gke is a private cluster, add the port-8443
webhook firewall rule.

### 6.2 Named-port audit

Every interceptable Service must reference its `targetPort` **by name** (the
ambient workaround from #3990). One-time audit + fix in the deploy repos'
manifests/Helm charts. Optional new `services.yaml` key
`gke_port_name: http` per service so the CLI can pass
`--port <local>:<name>` explicitly; absent → refuse with a pointer to the
audit doc. (This is the only registry change, and it is optional metadata —
additive, reversible, consistent with the "all service definitions live in
services.yaml" convention.)

### 6.3 Header propagation — the load-bearing open question

An intercept filter only matches if `x-feature: <feature>` **arrives at the
intercepted service**. For edge-facing services (web-v0/v1/v2, sb-web-api) the
dev ingress passing request headers through suffices (Assumed — verify). For
deep services (product-api behind federated-graph), the intermediate services
must **propagate** the header hop-to-hop, or the filter never matches and the
intercept sees nothing. Options if propagation is missing:

- Verify whether OTel baggage/trace headers are already propagated (the
  services emit OTel; Telepresence can filter on any header that survives).
- Add `x-feature` to the gateway/services' header-propagation allowlists
  (small app-side change, but touches product repos).
- Scope v1 to edge-facing services only, and document that limitation.

This must be answered by the Phase-0 spike before any CLI code is written.

## 7. Phases

- **Phase 0 — spike (no code).** By hand, against one edge service (web-v2)
  and one deep service (product-api): install a namespace-scoped
  traffic-manager, fix named ports for those two, run header-filtered
  intercepts from a Mac (test `--docker` connect mode with the corporate VPN
  up), and empirically answer §6.3. Exit: a runbook note recording what worked,
  or a decision to fall back to mirrord/DIY.
- **Phase 1 — platform.** Cluster-wide (or all-namespace) traffic-manager,
  named-port audit across deploy manifests, webhook firewall rule if needed.
- **Phase 2 — CLI.** `intercept.ts` + `lib/telepresence.ts`, `down`/`setup`
  hooks, tests (mock subprocess, per existing CLI test patterns), runbook in
  `docs/`.
- **Phase 3 — polish (optional, on demand).** `sandbox open --dev`,
  `sandbox status` intercept column, dashboard surfacing, wiretap mode for
  read-only debugging.

## 8. Risks & open questions

| # | Item | Status |
|---|------|--------|
| 1 | Header propagation to deep services (§6.3) | **Open — decides v1 scope; answered by Phase 0** |
| 2 | Is tr-dev-gke a private cluster (webhook 8443 firewall)? | Open — check before Phase 0 |
| 3 | Do dev Services use numeric `targetPort` today (audit size)? | Open — sample during Phase 0 |
| 4 | macOS root daemon acceptable to the team? (`--docker` mode mitigates; mirrord fallback if not) | Open |
| 5 | Platform/RBAC approval to install traffic-manager in tr-dev | Open — needs owner sign-off |
| 6 | Ambient behavior on future Istio upgrades (workaround is maintainer-confirmed but version-sensitive) | Accepted risk; pin telepresence version in `setup` |

## 9. Non-goals

- Replacing or modifying the docker-compose path, Caddy routing, slot
  allocation, or `gke-forwards`.
- Intercepting stateful infra (mongodb, redis, cloud-sql-proxy).
- Production or stage clusters — dev (`tr-dev-361214`) only.

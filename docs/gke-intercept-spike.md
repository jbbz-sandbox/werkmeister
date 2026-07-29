# Phase-0 Telepresence spike — findings

Runbook for Task 1 of `docs/superpowers/plans/2026-07-19-sandbox-gke-intercept.md`.
Filled in as steps run against the live **dev** cluster
(`gke_tr-dev-361214_us-central1_tr-dev-gke`). Records the go/no-go decision and
the interface facts consumed by Tasks 3–9.

## Environment at spike start (2026-07-19)

- `gcloud` authed as `jay.boyer@hginsights.com`; kube context present and current.
- Dev GKE runs **Istio ambient** (not sidecar) — relevant to the named-port blocker below.

### Telepresence install — plan hint was wrong (corrected)

The plan/spec install hint `brew install datawire/blackbird/telepresence-oss` fails twice:
1. **Formula name** — the `datawire/blackbird` tap provides `telepresence` /
   `telepresence-arm64` / `telepresence-legacy`, no `-oss`.
2. **Version** — that tap's `telepresence-arm64` is **v2.19.6**, below the required
   OSS ≥ 2.30.0 (ambient support).

Working install (local client only, no cluster change) — **done, v2.30.1**:

```bash
curl -fL https://github.com/telepresenceio/telepresence/releases/download/v2.30.1/telepresence-darwin-arm64 \
  -o /opt/homebrew/bin/telepresence && chmod +x /opt/homebrew/bin/telepresence
telepresence version   # OSS Client : v2.30.1
```

> **Task 8 follow-up:** fix the install hint in the plan + spec (`brew` → direct
> release download, or pin a tap that ships 2.30.x).

---

## Step 1 — Is tr-dev-gke a private cluster? ✅ run

```
enablePrivateNodes = True
```

**PRIVATE cluster.** Before Step 3 (traffic-manager install) the control plane must
reach the mutating webhook on **TCP 8443**. Add a master→node firewall rule for 8443,
or the traffic-manager webhook times out on connect/intercept.
See https://telepresence.io/docs/troubleshooting ("mutating webhook").

**BLOCKER — owner action needed:** create the master→node firewall rule for 8443
(spec §8 Q2). Track in the deploy/infra repo. See **Prep #1** below — a `gke-tr-dev-gke-webhooks`
rule already allows 8443 but only to tag `gke-tr-dev-gke`, which most nodes do NOT carry.

## Step 2 — Named-port audit, spike services ✅ run

`targetPort` values below are **numeric**, which is the ambient blocker
([telepresenceio#3990](https://github.com/telepresenceio/telepresence/issues/3990)).
Ambient-mesh intercepts require a **named** Service `targetPort` (e.g. `http`).

| Namespace | Service | targetPort | Named? | Action |
|-----------|---------|-----------|--------|--------|
| web-v2  | web-v2          | 3060        | ❌ numeric | name containerPort `http`, set svc `targetPort: http` |
| web-v2  | web-v2-waypoint | 15021 15008 | n/a (Istio ambient waypoint — not a target) | — |
| product | product-api     | 3001        | ❌ numeric | name containerPort `http`, set svc `targetPort: http` |

**BLOCKER — owner action needed:** name the ports in the owning deploy manifests /
Helm charts for `web-v2` and `product-api` before Step 5/6 intercepts can work.
Record repos/files touched here when done: _(TODO)_

---

## DevOps response — both blockers actioned (2026-07-20, DVO-3338)

Taylor Hawkins (platform) turned the guide into three **dev-only** PRs. **All three
MERGED 2026-07-20 (~22:14–22:21 UTC) and terraform applied** (confirmed via `gh`).
Diffs verified against our asks:

| PR | Repo | Delivers | Verified |
|----|------|----------|----------|
| [#2544](https://github.com/sandbox/infrastructure/pull/2544) | infrastructure | ArgoCD app `telepresence` (dest ns `ambassador`) → wrapper chart on `telepresence-oss` **2.30.1**, `namespaces: {web-v2, product}`, `agentInjector.webhook.port: 8443` | ✅ matches Step 3 (ns-scoped) |
| [#2545](https://github.com/sandbox/infrastructure/pull/2545) | infrastructure | terraform `google_compute_firewall.master_webhooks_telepresence`: 8443 ingress from `172.31.0.0/28`, **`target_service_accounts = [gke_service_account]`** | ✅ better than our draft (see below) |
| [#1943](https://github.com/sandbox/econx/pull/1943) | econx | web-v2 `charts/web-v2/dev.values.yaml`: `service.name: http`, `targetPort: http` (was `3060`) | ⚠️ one question (see below) |

**Two deliberate deviations from the guide — both accepted:**

1. **8443 firewall, not the 443-injector option.** On 2.30.1 the manager runs
   `runAsNonRoot` (uid 1000) and cannot bind privileged 443; the private-GKE firewall
   governs the pod container port regardless. **⇒ our "443 alternative" (Prep #1 note,
   guide §2.1) is dead — do not pursue it.** #2545 also targets the node **service
   account** rather than the node tag we drafted, so it covers NAP + static + dedicated
   pools without hardcoding the `-3f300f35-node` cluster hash. Adopt the SA approach.
2. **v1 scoped to web-v2 (edge) only; product-api deferred** until `x-feature`
   propagation reaches dev. Confirmed on our side: the `jayboyer/x-feature-propagation`
   branch is **0 commits ahead of `origin/main`** with **no PR** — propagation is **not
   in dev**. So deep-service intercepts can't receive the header yet; product-api stays
   out of v1. Agreed.

`failurePolicy: Ignore` on the webhook means the three PRs can merge in any order without
breaking pod admission — intercepts stay inert until both chart and firewall are live.

**Open review question on #1943 — RESOLVED ✅ (2026-07-20, verified in
`tr-helm-library` `standard-app` 0.5.1).** The chart **does** derive the pod's
`containerPort` name from `service.name`. `templates/workloads/deployment.yaml` builds
the container ports from a `containerPorts:` map if present, else falls to the
`else if $appConfig.service` branch:

```yaml
- name: {{ $appConfig.service.name }}          # → "http"
  containerPort: {{ $appConfig.service.port }}  # → 3060
```

web-v2's `dev.values.yaml` sets `service.name: http` and defines **no** `containerPorts:`
map, so the pod exposes a port **named `http`** (number 3060) and the Service's
`targetPort: http` resolves to that endpoint. Ambient precondition satisfied.

> **Caveat to record for future edits:** this holds *only* while web-v2 sets no
> `containerPorts:` map. If one is ever added, its keys become the port names and
> `service.name` is ignored — silently re-breaking the `http` name the intercept needs.

---

## Steps 3–8 — both platform blockers CLEARED (merged + applied); live run pending laptop auth

All three DVO-3338 PRs are **merged and terraform-applied** (2026-07-20). The two
remaining steps mutate the laptop / exercise live traffic and need **(a)** fresh
`gcloud auth login` — the dev kube creds expired at spike-completion time (every API
call 401s) — and **(b)** corporate VPN up.

- [x] **Step 3** — traffic-manager install: **now GitOps** via ArgoCD (#2544), not a
      manual `telepresence helm install`. Client installed locally (v2.30.1). PR merged;
      Argo sync assumed (verify with `kubectl -n ambassador get pods` once re-authed).
- [x] **Step 4** — RAN live. Docker mode connects with no sudo; **host mode connects once
      the root daemon is installed (interactive sudo in a real terminal)** — it can't
      launch from a non-interactive shell. status JSON captured for both. See *Step 4
      findings* + *Interface facts* below.
- [x] **Step 5** — intercept RAN live and **PROVEN end-to-end in host mode**: a header-tagged
      external request diverts to the laptop, an untagged one hits dev. Agent injects on
      demand ⇒ **#2545 firewall verified**; **Cloudflare preserves `x-feature`** to the agent.
      See *Step 5 findings* below.
- [x] **Step 6** — product-api (deep) intercept: **deferred out of v1** (propagation not in
      dev, see DevOps response). Revisit when `x-feature` propagation ships to dev.
- [x] **Step 7** — go/no-go recorded below.
- [x] **Step 8** — committed (spike complete: mechanism proven end-to-end).

### Step 4 findings — connect mode (live, 2026-07-21, VPN up)

Live-cluster prerequisites all verified before connecting:
- `kubectl -n web-v2 get svc web-v2` → `port=3060 targetPort=http` (**named targetPort live**).
- `kubectl -n web-v2 get deploy web-v2 -o jsonpath=…ports` → `http=3060` (**container port named**).
- `kubectl -n ambassador get pods` → `traffic-manager … Running` (#2544 synced).
- `kubectl get mutatingwebhookconfigurations` → `agent-injector-webhook-ambassador` present (#2544).

**Host mode FAILS non-interactively:** `telepresence connect` → `failed to launch the daemon
service: exit status 1`. The root daemon needs elevated privileges (macOS sudo/launchd
root-daemon install, telepresence 2.27+); it can't come up in an automated shell.

**Docker mode CONNECTS clean (no sudo):**
```
telepresence connect --docker --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
# → Launched Daemon / Connected … namespace web-v2 (https://34.123.184.53)
```

**⚠️ Connect-mode decision has a twist the plan didn't anticipate.** The sandbox's intercept
target is a **host-published** slot port (`localhost:<slot-port>`). In `--docker` mode the
intercept maps the cluster port to the **daemon container's** `127.0.0.1`
(`Intercepting 10.128.141.26 -> 127.0.0.1`), NOT the host — so a host-published slot port
is unreachable from a docker-mode intercept (it would require `--docker-run` with the local
service running as a container on telepresence's network). **⇒ the sandbox model requires
HOST mode**, which in turn requires the one-time root-daemon install. `--docker-daemon` is
therefore NOT a drop-in fallback for reaching the slot port — it changes where the local
target must live. Task 6 default stays host mode; document that `sandbox intercept` needs
the telepresence root daemon installed once (interactive), and treat `--docker-daemon` as
"only if you run the local service as a container on the tp network," not a VPN escape hatch.

### Step 5 findings — intercept (live, 2026-07-21)

Intercept goes **ACTIVE** and the header filter engages:
```
telepresence intercept web-v2 --port 18080:3060 --http-header x-feature=jay-spike --mount false
#   State        : ACTIVE
#   Intercepting : 10.128.141.26 -> 127.0.0.1   3060 -> 18080 TCP
#   Intercepting : HTTP requests with header 'X-Feature: jay-spike'
```
- Before the intercept `telepresence list` showed `traffic-agent not yet installed`; the
  intercept **injected the agent on demand** — which only succeeds if the control plane can
  reach the injector webhook on 8443 ⇒ **#2545 firewall is working end-to-end**.

**End-to-end header→laptop round trip: ✅ PROVEN (host mode, 2026-07-20).** After the root
daemon was installed (interactive sudo, in a real terminal), host-mode connect + intercept
routed a header-tagged external request to the laptop:

| Test (external client through the real ingress) | Result |
|--------------------------------------------------|--------|
| `curl -H 'x-feature: jay-spike' https://web-v2.dev.sandbox.com/` | 200, **21 bytes = `LAPTOP-INTERCEPT-HIT`** → laptop ✅ |
| `curl https://web-v2.dev.sandbox.com/` (no header) | 200, **150 KB = real dev page** → untouched ✅ |

Confirms: **Cloudflare → ingress → ambient mesh preserves `x-feature`** all the way to the
web-v2 traffic-agent, and only the tagged request diverts — baseline/teammate traffic is
unaffected. Two gotchas learned here:
- **Right host matters.** web-v2's ingress hostname is **`web-v2.dev.sandbox.com`**
  (HTTPRoute `web-v2-dev-sandbox-com`), NOT `sb-web.dev.sandbox.com` (a different
  app). Testing the wrong host silently hits the wrong workload and never diverts.
- **In-cluster curls from the connected machine are NOT a filter test.** Requests you
  originate to the service DNS (`web-v2.web-v2:3060`) while connected always route to your
  local handler regardless of header — the header filter only applies to traffic arriving
  through the mesh from *other* origins. Use an external client for the real test.

### Interface facts consumed by Tasks 4–9 — CORRECTIONS to the plan (telepresence 2.30.1)

The plan's arg-builders/parsers were drafted against older telepresence syntax. Live 2.30.1
differs — apply these before building Tasks 4–6, or every subprocess call is wrong:

| Plan draft | Correct in 2.30.1 | Where |
|-----------|-------------------|-------|
| `status --output json` | **`status --format json`** (`--output` deprecated) | `connected_namespace()` (Task 5) |
| status key `user_daemon` | **mode-dependent**: docker mode → top-level **`daemon`**; host mode → **`user_daemon`** (+ `root_daemon`). Both carry `{status:"Connected", running, namespace}`. Code checks both keys — verified live in each mode. | `connected_namespace()` (Task 5) |
| `intercept … --mounts false` | **`--mount false`** (singular) | `build_intercept_args()` (Task 4) |
| `--port <local>:http` (name) | **`--port <local>:3060`** (the Service PORT NUMBER) | `build_intercept_args()` (Task 4) |
| `telepresence leave <dep>` | **`telepresence detach <dep>`** (`leave` deprecated) | `build_leave_args()` (Task 4) |

**Why `--port` must use the number, not `http`:** #1943 named the Service **`targetPort: http`**
(the ambient precondition) but left the **Service `port` itself unnamed** (`port=3060` with no
`.name`). Telepresence's `--port <local>:<identifier>` matches the identifier against the
Service port name/number — `:http` → `no interceptable port matching port http`; `:3060` →
ACTIVE. Options for Task 3/4: (a) use `gke_port` (3060) as the identifier — simplest, no
platform change; or (b) ask platform to also set `name: http` on the Service port so `:http`
resolves. `gke_port_name` in services.yaml is still useful for the container-port assertion,
but the intercept identifier should be the number unless (b) ships.

**Saved `status --format json` shape (docker daemon), verbatim — Task 5 keys off `daemon`:**
```json
{"daemon":{"running":true,"status":"Connected","namespace":"web-v2","in_docker":true,
"kubernetes_context":"gke_tr-dev-361214_us-central1_tr-dev-gke","manager_namespace":"ambassador",
"mapped_namespaces":["product","web-v2"],"name":"gke_…-web-v2-cn","version":"2.30.1"},
"traffic_manager":{"version":"v2.30.1","name":"OSS Traffic Manager"}}
```
Note: in docker mode plain `status`/`list` need `--use <daemon-name>` (e.g.
`…-web-v2-cn`) because they otherwise look for the absent host root-daemon file.

### Remaining to close the spike (needs the interactive root daemon)

```bash
# one-time: install the telepresence root daemon (interactive sudo / launchd), then host-mode connect
sudo telepresence helm ... # or the guided root-daemon install prompt on first `telepresence connect`
./sandbox up jay-spike -s web-v2          # note the printed slot port
telepresence connect --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
telepresence intercept web-v2 --port <slot-port>:3060 --http-header x-feature=jay-spike --mount false
curl -is -H 'x-feature: jay-spike' https://sb-web.dev.sandbox.com/ | head   # → should hit the laptop
curl -is                             https://sb-web.dev.sandbox.com/ | head   # control → dev, not laptop
```

## Prep — drafted 2026-07-19, SUPERSEDED by DVO-3338 PRs (2026-07-20)

> **Superseded.** Platform delivered both prereqs as terraform/Helm PRs (see *DevOps
> response* above); our draft `gcloud`/`helm` commands below are no longer the path.
> Kept for provenance. Two corrections the PRs make to this draft:
> - **Firewall:** the PR targets the node **service account**, not the `-3f300f35-node`
>   tag drafted here — use the SA (covers all pools, no cluster-hash dependency).
> - **443 alternative (below): DEAD.** The manager runs uid 1000 and can't bind 443;
>   8443 + firewall is the only path. Ignore the "no firewall change" note.

### Prep #1 — firewall rule for the webhook (TCP 8443)

Facts gathered from the live cluster:

| Input | Value |
|-------|-------|
| Master (control-plane) CIDR | `172.31.0.0/28` |
| VPC network | `dev-vpc` |
| Universal node tag (all pools) | `gke-tr-dev-gke-3f300f35-node` |
| Existing 8443 rule `gke-tr-dev-gke-webhooks` | src `172.31.0.0/28` → **tag `gke-tr-dev-gke`** (only the NAP node carries it) |

The existing webhook rule does **not** cover the standard pools (cast-pool, mongodb
nodes carry only `...-3f300f35-node`). A dedicated, reversible rule on the universal
tag is the clean fix:

```bash
gcloud compute firewall-rules create gke-tr-dev-gke-telepresence-8443 \
  --project tr-dev-361214 --network dev-vpc \
  --direction INGRESS --action ALLOW --rules tcp:8443 \
  --source-ranges 172.31.0.0/28 \
  --target-tags gke-tr-dev-gke-3f300f35-node \
  --description "Allow GKE control plane → Telepresence agent-injector webhook (8443) on all nodes"
```

Rollback: `gcloud compute firewall-rules delete gke-tr-dev-gke-telepresence-8443 --project tr-dev-361214`.

> **Alternative (no firewall change):** install the traffic-manager with the
> agent-injector on **443** instead of 8443 (already open via the master rule):
> `telepresence helm install --set agentInjector.webhook.port=443 ...`. Prefer this
> if infra is slow to add the rule — record which path was taken.

### Prep #2 — name the numeric `targetPort`s (ambient blocker)

Not in this repo — these live in the owning deploy manifests / Helm charts (ops-cicd-k8s
or the service repos). Per service, two edits:

**web-v2** (namespace `web-v2`, port 3060):
```yaml
# Deployment: spec.template.spec.containers[].ports[]
- name: http          # ADD
  containerPort: 3060
# Service: spec.ports[]
- port: 3060
  targetPort: http    # was 3060
```

**product-api** (namespace `product`, port 3001): same shape, `targetPort: http`.

Record repos/files touched here when done: _(TODO)_

### Next runnable steps once #1 and #2 land (+ VPN up)

```bash
# Step 3 (namespace-scoped traffic-manager for the two spike namespaces)
telepresence helm install --set "namespaces={web-v2,product}" \
  --kube-context gke_tr-dev-361214_us-central1_tr-dev-gke
# Step 4 — save this output; Task 5 codes against its shape
telepresence connect --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
telepresence status --output json
```

---

## Phase-1 rollout — named-port audit (all 11 sandbox namespaces, live 2026-07-21)

Task 2 Step 2 audit. Every interceptable service in `services.yaml` vs its **live** k8s
Service `targetPort`. Only **web-v2 is named**; all others are numeric and need the #1943
treatment before they can be intercepted (ambient blocker, telepresenceio#3990).

| services.yaml service | namespace | k8s Service | live targetPort | named? | edge/deep |
|-----------------------|-----------|-------------|-----------------|--------|-----------|
| web-v2         | web-v2           | web-v2                    | **http** | ✅ done (#1943) | edge |
| web-v0         | sandbox      | sandbox-web-app       | 3000 | ❌ | edge |
| web-v1         | sandbox      | sandbox-next-app      | 3030 | ❌ | edge |
| sb-web-api     | sandbox      | sandbox-sb-web-nx-api | 3061 | ❌ | edge |
| vendor         | vendor-portal    | vendor-portal-client      | 3000 | ❌ | edge |
| vendor-portal-server | vendor-portal | vendor-portal-server     | 3003 | ❌ | edge |
| federated-graph | federated-graph | federated-graph          | 4321 | ❌ | gateway |
| product-api    | product          | product-api               | 3001 | ❌ | deep |
| category-api   | category         | category-api              | 3001 | ❌ | deep |
| taxonomy-api   | taxonomy-service | taxonomy-service-api      | 3001 | ❌ | deep |
| user-api       | user-service     | user-service-api          | 3001 | ❌ | deep |
| award-api      | award-service    | award-service-api         | 3005 | ❌ | deep |
| interview-api  | interview-service | interview-service-api    | 3004 | ❌ | deep |
| sandbox-mcp | sandbox-mcp | sandbox-mcp           | 4322 | ❌ | deep |

**⚠️ Registry drift found:** `services.yaml` had `gke_port_name: http` on **product-api**,
but its live Service `targetPort` is numeric `3001` — the fix never shipped (only web-v2's
#1943 did). That key was removed 2026-07-21 so `sandbox intercept -s product-api` correctly
refuses until the manifest is actually fixed.

**Rollout scoping (edge-first):** the named-port fix is a prerequisite for *all* rows, but
deep subgraphs can't receive `x-feature` until propagation ships to dev — so fixing their
ports first buys nothing. Recommend platform prioritize the **edge** rows (usable
immediately) and batch the **deep** rows with the propagation work. The DevOps ask is in
`docs/gke-intercept-devops-guide.md` §4.

## Go/no-go — ✅ GO (Telepresence), v1 scope = web-v2 edge only

**Decision (2026-07-20):** proceed with **Telepresence OSS 2.30.1** — no mirrord fallback.
Tasks 2–9 of the plan are unblocked to proceed. Both platform prerequisites that gated
this decision are now delivered as dev-only PRs (DVO-3338):

1. master→node **firewall 8443** — [infrastructure#2545](https://github.com/sandbox/infrastructure/pull/2545) (node-SA-targeted).
2. **named `targetPort`** on web-v2 — [econx#1943](https://github.com/sandbox/econx/pull/1943); traffic-manager via [infrastructure#2544](https://github.com/sandbox/infrastructure/pull/2544).

**v1 scope:** **edge services (web-v2) only.** product-api and other deep services are
deferred until `x-feature` propagation ships to dev (currently not in dev — see above).

**GO reconfirmed live 2026-07-21** against the real cluster: named port rolled out, traffic-
manager Running, agent injects on intercept (#2545 firewall verified), intercept goes ACTIVE
with the `x-feature` header filter. The three items the plan left open are now resolved:

- ✅ `status --format json` shape captured (see *Interface facts*) — and the plan's key
  (`user_daemon`) and flag (`--output`) are both **wrong for 2.30.1**; corrected there.
- ✅ Connect-mode default: **host mode** (the sandbox's host-published slot port is only
  reachable in host mode; docker mode targets the daemon-container loopback). Caveat: host
  mode needs the one-time interactive root-daemon install — call this out in Task 9 docs.
- ✅ **Full header→laptop round trip PROVEN** (host mode, 2026-07-20): a header-tagged
  external request to `web-v2.dev.sandbox.com` diverts to the laptop; an untagged one
  hits dev. Cloudflare preserves `x-feature` to the agent. Spike is complete — no gaps.

Additional plan corrections surfaced (telepresence 2.30.1 syntax drift): `--mount` (not
`--mounts`), `--port :3060` (number, not `:http` — Service port is unnamed), `detach` (not
`leave`). All tabulated under *Interface facts consumed by Tasks 4–9*. Build Tasks 4–6
against that table, not the plan's original arg strings.

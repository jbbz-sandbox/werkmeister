# Enabling Telepresence intercepts on dev GKE — a guide for the platform team

**Audience:** the DevOps / platform team that owns `tr-dev-gke`.
**Purpose:** agree on the cluster-side prerequisites before we ship a `sandbox intercept`
developer command. Everything below targets **dev only** (`gke_tr-dev-361214_us-central1_tr-dev-gke`);
nothing here touches stage or prod.
**Companion docs:** `docs/gke-intercept-spike.md` (raw findings),
`docs/superpowers/specs/2026-07-19-sandbox-gke-intercept-design.md` (full design).

> **✅ Resolved 2026-07-20 (DVO-3338).** Platform delivered all three asks as dev-only PRs:
> traffic-manager chart [infrastructure#2544](https://github.com/sandbox/infrastructure/pull/2544),
> 8443 firewall [infrastructure#2545](https://github.com/sandbox/infrastructure/pull/2545),
> web-v2 named port [econx#1943](https://github.com/sandbox/econx/pull/1943). Two decisions
> settled: **(1)** went with the 8443 firewall — the 443-injector option in §2.1 is **not
> viable** (manager runs uid 1000, can't bind 443); **(2)** v1 = **web-v2 edge only**,
> product-api deferred (header propagation not yet in dev). This guide is now historical;
> live status lives in `docs/gke-intercept-spike.md`.

---

## 1. What we're trying to do, and why it needs cluster changes

Developers want to route **a header-scoped slice of live dev traffic** to a service
running on their laptop — e.g. "send only requests carrying `x-feature: jay-test` to my
local `web-v2`, leave everyone else on the deployed version." This is far cheaper and
higher-fidelity than replicating the whole dependency graph locally.

We're using **Telepresence OSS** (CNCF, Apache-2.0, v2.30.1) to do it. Telepresence is
not purely client-side — to splice a laptop into the mesh it installs a small control
component in the cluster. That's why we need your sign-off. Concretely it adds:

| Component | Where | Lifetime | What it does |
|-----------|-------|----------|--------------|
| **traffic-manager** | one Deployment + Service in a manager namespace (`ambassador` by default; can be namespace-scoped) | persistent | Brokers intercepts, holds the routing rules |
| **agent-injector** | one `MutatingWebhookConfiguration` | persistent | On pod creation for *targeted* workloads, injects a traffic-agent sidecar |
| **traffic-agent** | a sidecar container | only in pods of a workload with an **active** intercept | Forwards matching requests to the developer's laptop |

Key property: **the agent is injected only when a developer starts an intercept**, and by
default only requests matching the developer's header are diverted — everything else keeps
hitting the deployed pod. When no one is intercepting, the data path is unchanged.

---

## 2. The prerequisites (what we're asking for)

Two blockers surfaced when we probed the cluster. Neither is optional; both are one-time.

### Step 1 — Open the webhook port from the control plane to the nodes (TCP 8443)

**What:** add an ingress firewall rule allowing the GKE control plane to reach TCP **8443**
on the nodes.

```bash
gcloud compute firewall-rules create gke-tr-dev-gke-telepresence-8443 \
  --project tr-dev-361214 --network dev-vpc \
  --direction INGRESS --action ALLOW --rules tcp:8443 \
  --source-ranges 172.31.0.0/28 \
  --target-tags gke-tr-dev-gke-3f300f35-node \
  --description "Allow GKE control plane → Telepresence agent-injector webhook (8443) on all nodes"
```

**Rationale:** `tr-dev-gke` is a **private cluster** (`enablePrivateNodes: True`). GKE
auto-creates control-plane→node firewall rules only for a fixed set of ports (443, 10250).
The agent-injector's mutating webhook listens on **8443**, so pod admission would hang
without this rule — the well-documented private-GKE + admission-webhook failure mode.

**Why a new rule and not the existing one:** there is already a `gke-tr-dev-gke-webhooks`
rule that allows 8443 — **but** it targets network tag `gke-tr-dev-gke`, and our audit
shows only the node-auto-provisioned (NAP) node carries that tag. The standard pools
(cast-pool, mongodb) carry only `gke-tr-dev-gke-3f300f35-node`. A traffic-manager pod
scheduled on a standard-pool node would not be reachable. The new rule targets the
**universal** node tag, so it covers every pool.

**Blast radius:** narrow. Source is only the control-plane CIDR `172.31.0.0/28`; a single
TCP port; ingress only. It does not widen node-to-node or internet exposure.

**Rollback:** `gcloud compute firewall-rules delete gke-tr-dev-gke-telepresence-8443 --project tr-dev-361214`.

**~~Lower-privilege alternative~~ (RULED OUT 2026-07-20):** we originally floated serving the
webhook on **443** to avoid a VPC rule. This does **not** work on 2.30.1 — the traffic-manager
runs `runAsNonRoot` (uid 1000) and cannot bind privileged 443, and the private-GKE firewall
governs the pod container port regardless. The 8443 firewall (DVO-3338 / #2545) is the path.

---

### Step 2 — Name the numeric Service `targetPort`s on the workloads we intercept

**What:** for each service we want to intercept, give its container port a **name** and
point the Service `targetPort` at that name. Example for `web-v2`:

```yaml
# Deployment: spec.template.spec.containers[].ports[]
- name: http          # ADD
  containerPort: 3060
# Service: spec.ports[]
- port: 3060
  targetPort: http    # was the literal 3060
```

Same change for `product-api` (port 3001), and later for each additional service we roll
out to (full list in §4).

**Rationale:** the dev cluster runs **Istio in ambient mode**. Telepresence's ambient
integration requires the Service `targetPort` to be a **named** port; a numeric
`targetPort` is the exact blocker tracked in
[telepresenceio#3990](https://github.com/telepresenceio/telepresence/issues/3990). Our
audit found both spike services use numeric ports today (`web-v2: 3060`, `product-api: 3001`).

**Ownership note:** unlike Step 1, this change lives in the **application deploy manifests /
Helm charts** (owned by the service teams / in the ops repo), not in cluster config. It's a
no-op for normal traffic — naming a port and referencing it by name resolves to the same
endpoint — but it should ride through the normal deploy review + rollout for each service.

**Blast radius:** effectively none functionally; it's a metadata change to the port
reference. Risk is limited to a typo in the port name, caught by the normal deploy check.

**Rollback:** revert the manifest change (set `targetPort` back to the numeric value).

---

### Step 3 — Install a namespace-scoped traffic-manager

**What:** install the traffic-manager, scoped to only the namespaces we intercept — for the
initial spike, just two:

```bash
telepresence helm install --set "namespaces={web-v2,product}" \
  --kube-context gke_tr-dev-361214_us-central1_tr-dev-gke
```

**Rationale:** installing namespace-scoped (rather than cluster-wide) keeps the agent-injector
webhook and the manager's RBAC limited to the namespaces developers actually intercept —
least privilege, smallest possible footprint. We start with the two spike namespaces to
validate end-to-end before any wider rollout.

**What this creates:** the traffic-manager Deployment/Service in the manager namespace, the
`MutatingWebhookConfiguration` scoped to the listed namespaces, and the supporting RBAC.
No workloads are modified at install time — agents are injected only when an intercept starts.

**Blast radius:** with no active intercepts, request paths are unchanged. The webhook only
acts on pods in the listed namespaces, and only to add a dormant sidecar to workloads that
are being intercepted.

**Rollback:** `telepresence helm uninstall --kube-context …` removes the manager, the
webhook, and the RBAC. Any injected agents disappear on the next pod roll.

---

## 3. How an actual intercept behaves (so you can reason about risk)

Once the above is in place, a developer runs (from their laptop, on VPN):

```bash
telepresence connect --namespace web-v2 --context …
telepresence intercept web-v2 --port <local-port>:http --http-header x-feature=jay-test
```

- Only requests carrying `x-feature: jay-test` are routed to the developer's laptop.
- All other traffic continues to the deployed pod, untouched.
- The intercept is **personal and ephemeral** — it ends when the developer disconnects.
- We deliberately ship **v1 as `intercept` mode only** (no `replace`/global takeover), so a
  developer can never divert *all* traffic for a service.

**Open design question for you (§6.3 of the spec):** does the `x-feature` header survive
gateway → subgraph propagation to deep services like `product-api`? A separate workspace is
adding that propagation. Until it reaches dev, deep-service intercepts won't receive the
header, so v1 scope is effectively **edge services** (web-v2). We'd like your read on where
header propagation stands in dev.

---

## 4. Phase-1 rollout ask (DVO follow-up to DVO-3338)

The web-v2 spike succeeded end-to-end (intercept ACTIVE, agent injects → the 8443 firewall
works). Two asks to widen coverage. Both are dev-only and follow the patterns already merged
in DVO-3338; nothing is rolled out cluster-wide in one shot.

### 4a. Extend the traffic-manager `namespaces:` to all sandbox namespaces

One value change on the ArgoCD wrapper chart from #2544 (`namespaces: {web-v2, product}` →
the full set). Cheap and low-risk — the injector only acts on pods in these namespaces, and
only when an intercept is active, so widening the list changes no data path until a developer
intercepts a *named-port* service (4b gates that per service).

```yaml
namespaces:
  - sandbox
  - web-v2
  - product
  - category
  - federated-graph
  - vendor-portal
  - taxonomy-service
  - interview-service
  - award-service
  - user-service
  - sandbox-mcp
```

### 4b. Name the numeric Service `targetPort`s — edge services first

Same one-line-per-service change as web-v2/#1943 (name the containerPort, point the Service
`targetPort` at the name). Our live audit (2026-07-21, full table in
`docs/gke-intercept-spike.md`) found **only web-v2 is named today**; every other service is
numeric. **Prioritize the edge services** — deep subgraphs can't receive the `x-feature`
header until propagation ships to dev, so naming their ports first buys nothing:

| Priority | Service (repo/chart) | namespace | k8s Service | targetPort today → | 
|----------|----------------------|-----------|-------------|--------------------|
| **edge (now)** | web-v0 (sandbox) | sandbox | sandbox-web-app | `3000` → `http` |
| **edge (now)** | web-v1 (sandbox) | sandbox | sandbox-next-app | `3030` → `http` |
| **edge (now)** | sb-web-api (sandbox) | sandbox | sandbox-sb-web-nx-api | `3061` → `http` |
| **edge (now)** | vendor-portal-client | vendor-portal | vendor-portal-client | `3000` → `http` |
| **edge (now)** | vendor-portal-server | vendor-portal | vendor-portal-server | `3003` → `http` |
| deep (later) | federated-graph | federated-graph | federated-graph | `4321` → `http` |
| deep (later) | product-api | product | product-api | `3001` → `http` |
| deep (later) | category-api | category | category-api | `3001` → `http` |
| deep (later) | taxonomy-api | taxonomy-service | taxonomy-service-api | `3001` → `http` |
| deep (later) | user-api | user-service | user-service-api | `3001` → `http` |
| deep (later) | award-api | award-service | award-service-api | `3005` → `http` |
| deep (later) | interview-api | interview-service | interview-service-api | `3004` → `http` |
| deep (later) | sandbox-mcp | sandbox-mcp | sandbox-mcp | `4322` → `http` |

Each rides its own deploy review (functionally a no-op — a named port resolves to the same
endpoint). We'll add `gke_port_name` in `services.yaml` per service as each fix lands.
(Note: product-api previously carried a premature `gke_port_name: http` in our registry; we
removed it until the manifest change actually ships, so the CLI refuses it in the meantime.)

---

## 5. Summary — decisions we need from the platform team

| # | Decision | Options | Our recommendation |
|---|----------|---------|--------------------|
| 1 | Webhook reachability | New 8443 firewall rule **or** injector on 443 | Either; 443 avoids a VPC change |
| 2 | Named-port manifest change | Approve for web-v2 + product-api | Approve — functionally a no-op |
| 3 | Traffic-manager install | Namespace-scoped to `{web-v2, product}` | Namespace-scoped (least privilege) |
| 4 | Header propagation to deep services | Confirm dev status | Informs v1 scope (edge vs deep) |

**Environment facts referenced above (from the live cluster, 2026-07-19):**

- Cluster: `gke_tr-dev-361214_us-central1_tr-dev-gke`, **private nodes = True**
- Control-plane CIDR: `172.31.0.0/28` · VPC: `dev-vpc`
- Universal node tag: `gke-tr-dev-gke-3f300f35-node`
- Existing 8443 rule `gke-tr-dev-gke-webhooks` targets tag `gke-tr-dev-gke` (NAP node only)
- Mesh: **Istio ambient**
- Telepresence: **OSS v2.30.1** (client already installed locally)

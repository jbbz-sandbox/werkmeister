# Topology: where each piece runs

Which machine, and which container, every part of the sandbox lives in — and what
crosses the boundary between your laptop and the cluster.

The short version: **containers are local, Kubernetes is remote, and telepresence
is the only piece that can sit on either side.** That last choice is
`sandbox intercept --docker-daemon`, and it is the only decision in this document.

The same two diagrams, rendered in colour and easier to read at a glance:
<https://claude.ai/code/artifact/c4e95b16-b1ef-437c-880c-8ab2867030c4>
(access is granted per person — ask the repo owner if it 404s for you). The ASCII
below is the copy of record and stays correct on its own.

---

## The intended shape

```
DEVELOPER LAPTOP                                 KUBERNETES (shared, cloud)
                                           internet/VPN
┌────────────────────────────────────┐      ┊    ┌────────────────────────────────┐
│ sandbox · telepresence · kubectl   │ ──(1)────►│ API server                     │
│ plain binaries — mac/Linux/WSL     │      ┊    │   a real hostname              │
└────────────────────────────────────┘      ┊    ├────────────────────────────────┤
┌────────────────────────────────────┐      ┊    │ traffic-manager                │
│ CONTAINER RUNTIME — DOCKER/OCI     │      ┊    │   install once per cluster     │
│ any Docker-API engine: Docker      │      ┊    ├────────────────────────────────┤
│ Desktop, OrbStack, Colima, …       │   ┌──┊────│ backend pod                    │
├────────────────────────────────────┤   │  ┊    │   app + traffic-agent sidecar  │
│ caddy — ingress per feature        │   │  ┊    ├────────────────────────────────┤
├────────────────────────────────────┤   │(3)    │ frontend · postgres · redis    │
│ k8s-forwards                       │ ◄─┼──┊────│   the shared dev baseline      │
│   a port-forward per service       │   │(2)┊   └────────────────────────────────┘
├────────────────────────────────────┤   │  ┊
│ your feature: backend, …           │ ◄─┘  ┊
│   slot 3 → published :11300        │      ┊
├────────────────────────────────────┤      ┊
│ telepresence daemon container      │      ┊
│   --docker-daemon only             │      ┊
└────────────────────────────────────┘      ┊
```

Only three things cross the boundary:

1. **The kubeconfig** — how the CLI, `kubectl` and telepresence authenticate.
2. **Port-forwards** — one per cluster service you are *not* running locally,
   held open by the `k8s-forwards` container.
3. **Intercepted traffic** — during an intercept only, header-matched requests
   leaving the traffic-agent and arriving at your local container.

Everything else is local: compose builds, Caddy routing, file watching, tests,
and the whole edit loop.

The container runtime is the developer's own choice. The sandbox speaks only the
Docker API, and `infra/compose/shared-infra.yml` maps
`host.docker.internal:host-gateway` — the portable form — so plain `dockerd` on
Linux behaves like Docker Desktop or OrbStack on a Mac.

---

## What actually needs the cluster

| Command | Cluster | Talks to |
|---|---|---|
| `up` · `down` · `restart` | no | docker compose |
| `status` · `logs` · `test` · `open` | no | container state, published ports |
| `workspace` · `list-workspaces` | no | git worktrees on disk |
| `connect` | for forwards | starts `k8s-forwards`, one `kubectl port-forward` per service |
| Caddy fallback routes | for services you don't run | the `k8s-*` upstreams that container exposes |
| `intercept` | required | traffic-manager + a traffic-agent; refused unless the service declares `k8s_deployment`, `k8s_namespace` and `k8s_port` |

A registry whose services declare no `k8s_forward_port` yields an empty forward
table rather than an error — the shape a fully self-hosted registry
assumes, where nothing runs in a cluster at all and telepresence never enters the
picture.

---

## Where telepresence runs

The binary is always on the host. What moves is its two daemons.

**Host mode (the default).** Two processes on your machine:

```
you   telepresence userd  --config .../config.yml
root  telepresence rootd  --cache ~/Library/Caches/telepresence
root  sudo -b -p [sudo: telepresence network daemon] Password:
```

That third line is the password prompt people ask about. It is telepresence's own
`sudo`, not the sandbox's: root is needed for a TUN device, `/etc/resolver/*` and
the routing table. It comes **once per root-daemon lifetime** — until
`telepresence quit -s` or a reboot — not once per intercept.

**Docker mode (`--docker-daemon`).** Both daemons in one container, on a network
telepresence creates. Nothing telepresence-related runs on the host, so nothing
asks for a password.

```
HOST MODE (default)

  cluster pod — traffic-agent
        │  encrypted tunnel
        ▼
  userd + rootd, processes on your machine
  [sudo: telepresence network daemon]
        │  --address 127.0.0.1  — already your laptop
        ▼
  your container, published on :11300


--DOCKER-DAEMON

  cluster pod — traffic-agent
        │  encrypted tunnel
        ▼
  daemon container — no sudo, the runtime owns the routing
        │
        ├─ default --address 127.0.0.1 ──► the container ITSELF → {"error":"EOF"}
        │
        └─ --address host.docker.internal ──► your container :11300
                                              ▲ what the CLI passes for you
```

The right-hand fork is the one thing docker mode gets wrong on its own, so the
CLI passes `--address host.docker.internal` whenever `--docker-daemon` is set
(`buildInterceptArgs` in `packages/sandbox-core/telepresence.ts`). Host mode's
`127.0.0.1` default already names the right machine and is left alone.

| | host mode | `--docker-daemon` |
|---|---|---|
| Password prompt | yes, per root-daemon lifetime | no |
| `backend.default` resolves on the laptop | yes | **no** |
| Host routing table | shared with your VPN | untouched |
| Needs a working Docker | only for your services | for the daemon too |

Pick host mode when you want to `curl` cluster hostnames from your own shell.
Pick `--docker-daemon` when a VPN is fighting the routing table, or when the
password prompt is in the way. Traffic flowing cluster → laptop is identical
either way. Switching modes means `telepresence quit -s` first.

---

## Running against a cloud cluster

Most of it is already handled:

- The forwards container is fed `kubectl config view --raw --minify --flatten`,
  so certificates and tokens are **inlined**, not left as host paths the
  container cannot see.
- `shimLocalApiServer` (`packages/sandbox-core/infra.ts`) rewrites a
  `127.0.0.1` API address to `host.docker.internal` and drops CA verification —
  and no-ops for a remote cluster, which needs neither. Telepresence's docker
  mode does the same rewrite for the same reason. A local cluster is the special
  case here, not the cloud one.

**Check first: `exec` credential plugins.** Managed clusters usually authenticate
through one — `aws eks get-token`, `gke-gcloud-auth-plugin`, `az`, an OIDC
helper. That stanza survives `--flatten` as a command the *container* is then
expected to run, and the `k8s-forwards` image
(`infra/compose/k8s-port-forward/Dockerfile`) ships `kubectl` and nothing else.

- Host side: fine. Your `kubectl`, and telepresence in host mode, run where the
  plugin and its credentials already live.
- Containerized side: the forwards image, and telepresence's daemon container
  under `--docker-daemon`. Either bake the plugin and its credentials in, or
  issue those two a long-lived token or client certificate instead.

Also worth knowing, none of it blocking:

- **The traffic-manager is per cluster.** Install it once in the cloud cluster
  before the first intercept. Nothing else in the sandbox needs anything
  installed there.
- **Intercepted requests cross the internet** — cluster to laptop and back on
  every matched request. Fine for a debug loop, visible in a latency-sensitive
  test.
- **A private API endpoint means a VPN**, which is exactly what host mode's TUN
  device tends to fight over. This is the strongest argument for
  `--docker-daemon` in a real deployment: the daemon container egresses through
  the host, so the VPN still carries it, but the host's own routing table is
  left alone.

### The local-cluster variant

A cluster on the same machine (OrbStack's built-in Kubernetes, kind, minikube,
k3d) collapses the right-hand side of the first diagram into the same box as your
containers, and its API server appears at `127.0.0.1`. That address is what the
two rewrites above exist for. Everything else — slots, Caddy, forwards, the
intercept path — behaves identically, which is why it works as a stand-in when
no cloud cluster is available.

---

**See also:** [`sandbox intercept` in the users guide](users-guide.md#sandbox-intercept)
for flags and worked commands; [architecture](sandbox-architecture.md) for how
Caddy chooses between a local container and the cluster baseline.

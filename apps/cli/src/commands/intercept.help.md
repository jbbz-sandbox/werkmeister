## Description

Only requests carrying `x-feature: <feature>` are rerouted; teammates and baseline dev
traffic reach the cluster workload untouched. The intercept target is the container
`werkmeister up` already published on the feature's slot port, so hot reload keeps working.

**Two daemon modes.** Telepresence has to get cluster traffic onto your laptop, and there
are two places its daemon can live. [docs/topology.md](topology.md) draws the whole picture,
including what changes when the cluster is a managed one in the cloud.

| | host mode (default) | `--docker-daemon` |
|---|---|---|
| Asks for your password | **Yes** — root creates a TUN device, writes `/etc/resolver/*`, adds routes | **No** |
| Cluster DNS on the host (`backend.default` resolves in your shell) | Yes | **No** |
| VPN routing conflicts | Possible — both want the routing table | Avoided |
| Requires a working Docker | Only for your services | Yes, for the daemon too |

The password prompt is telepresence's own `sudo`, not Werkmeister's. It comes once per root
daemon lifetime — until `telepresence quit -s` or a reboot — not once per intercept.

Pick host mode when you want to `curl backend.default` or point host-side tooling at cluster
names. Pick `--docker-daemon` when the password prompt or a VPN is in your way, and accept
that cluster names resolve nowhere on the host while it is connected. Traffic flowing
cluster → laptop, which is what an intercept is for, behaves identically in both.

Switching modes means dropping the current daemon first:

```bash
telepresence quit -s
werkmeister intercept my-feature -s backend --docker-daemon
```

**On OrbStack** (the default `k8s_context`), docker mode works with no extra configuration.
Two details, both verified live rather than assumed:

- The kubeconfig points at `https://127.0.0.1:26443`, which inside a container would be the
  container itself. Telepresence ≥ 2.31 rewrites it to `host.docker.internal` on its own,
  and OrbStack's API certificate already covers that name — so `connect --docker` needs no
  `--server` override.
- The intercept does need `--address host.docker.internal`, which the CLI passes for you.
  Without it telepresence forwards to `127.0.0.1` *inside the daemon container*, and the
  cluster's request dies as `{"error":"EOF"}` while your local container sits idle.

```bash
# Start the feature first (with backend in workspace.yml's services) — the local container is the intercept target
werkmeister up my-feature
werkmeister intercept my-feature -s backend --docker-daemon

# From inside the cluster: the header reaches your laptop, bare traffic does not
kubectl run probe --rm -i --restart=Never --image=curlimages/curl:latest --quiet -- \
  curl -s -H "x-feature: my-feature" http://backend.default/

werkmeister intercept my-feature --leave -s backend
```

A service can only be intercepted if it declares `k8s_deployment`, `k8s_namespace` and
`k8s_port` in the registry; `werkmeister status --intercepts` reports what is interceptable and
what is currently intercepted.

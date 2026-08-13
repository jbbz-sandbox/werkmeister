---
kind: example
canonical: demo-services:.env.example
---

# Datastore URLs: DNS alias, and the port depends on which network you're on

A service reached from two networks has two addresses, and only the port
differs — which is exactly why it gets written down wrong. In the sandbox the
container mesh reaches Postgres through the `k8s-forwards` container, so the
port is that forwarder's *listen* port (`9051`); inside the cluster the same
database is a ClusterIP Service on its real port (`5432`). Same DNS-alias rule
both times, different number.

Neither value belongs in a generated file. The workspace `.env` is gitignored
and `sandbox init-workspace` doesn't emit datastore URLs at all — it only loops
over `services:` — so a hand-added block is wiped on the next rerun. The
committed `.env.example` is the record of what to re-add; the in-cluster
variants live in the per-release chart values, next to the deploy that uses
them.

## The load-bearing part

```sh
# Ports below are the k8s-forwards LISTEN ports, not the in-cluster service ports.
# Use the shared-network DNS aliases, never host.docker.internal — that resolves only
# on the Docker host, so a container using it works on exactly one machine.

# backend → Postgres
DATABASE_URL=postgres://postgres:postgres@k8s-postgres:9051/postgres

# frontend → Redis (SSR cache for the grocery list)
REDIS_URL=redis://k8s-redis:9050

# In-cluster (bin/deploy.sh) the values differ — cluster DNS + real service ports.
# Those live in charts/backend.values.yaml and charts/frontend.values.yaml, not here:
#   DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
#   REDIS_URL=redis://redis:6379
```

`host.docker.internal` was ruled out here even though the generated
`.sandbox/sandbox-context.md` documents it — the forwarder binds
`--address 0.0.0.0`, so the DNS alias works and the host-relative form buys
nothing but a machine-specific config.

## Description

Shows shared infrastructure, every active feature and the k8s port-forwards in one view.

**Output example:**

```
=== Werkmeister Status ===

  Infrastructure
  Service                    Status
  ────────────────────────────────────────
  caddy                      healthy
  k8s-forwards               healthy
  mcp-web-server             healthy

  Features
  Host load 1.8 2.1 2.0 (10 cores)  |  feature containers 14% CPU
  Slot  Feature                    Services                             Ports            Status
  ───────────────────────────────────────────────────────────────────────────────────────────────
     1  my-feature                 backend, frontend                    11100-11119      up (2/2)  12.3% CPU · 410 MiB · started 2 h ago by up
     3  other-feature              frontend                             11300-11319      partial (0/1)

  k8s Port-Forwards
  Service                    Ports              Health check                  Status
  ─────────────────────────────────────────────────────────────────────────────────────
  redis                      :9050 → :6379      (tcp)                         alive
  postgres                   :9051 → :5432      (tcp)                         alive
  backend                    :9052 → :80        /health                       alive
  frontend                   :9053 → :8080      /                             dead

  2 active feature(s), 10 slot(s) available  |  k8s: 3/4 alive

  To restart dead forwards: docker restart w9r-k8s-forwards
```

**Status indicators:**
- `up (N/M)` (green) — all containers running
- `partial (N/M)` (yellow) — some containers running
- `paused (0/M)` (cyan) — every container paused
- `down (0/M)` (red) — no containers running
- `no containers` (dim) — compose file exists but no containers found

A feature's row ends with its CPU and memory and how long ago it started, when known. A container that keeps restarting adds a red `✗ <service> crash-looping (N restarts)` line under it; `--verbose` lists each container. Features waiting for a slot show as `Waiting for capacity: <feature> (#1)`.

**`werkmeister infra status`** shows only the k8s port-forwards (`feature status --k8s` is deprecated). Each forward is one row: the listen port on this machine mapped to the remote port, the health check (`(tcp)` or an HTTP path) and `alive`, `dead` or `unknown`:

```
=== k8s Port-Forward Status ===

  k8s Port-Forwards
  Service                    Ports              Health check                  Status
  ─────────────────────────────────────────────────────────────────────────────────────
  redis                      :9050 → :6379      (tcp)                         alive
  postgres                   :9051 → :5432      (tcp)                         alive
  backend                    :9052 → :80        /health                       alive
  frontend                   :9053 → :8080      /                             dead

  3/4 services alive

  To restart dead forwards: docker restart w9r-k8s-forwards
```

When the forwards container is not running, it says so instead of listing rows: `not running` (start it with `werkmeister infra connect`), `container w9r-k8s-forwards is down`, or `stopped — not needed by any running workspace`.

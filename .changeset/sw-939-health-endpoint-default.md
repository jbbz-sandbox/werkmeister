---
"werkmeister": patch
"werkmeister-core": patch
---

A service with no `health_endpoint` now gets the same probe everywhere: `GET /health`, which the compose healthcheck already used (SW-939). The `pr gate` / `pr open` baseline row probed `/` and its k8s forward a TCP connect. An `infrastructure:` forward with none stays TCP-only, and `""` still means TCP. A forwarded *service* with none changes from a TCP connect to `GET /health` (any answer below 500 passes), so a non-HTTP one registered without the field needs `health_endpoint: ""`, or the k8s-forwards container restarts its tunnel.

---
"werkmeister": patch
---

The `baseline <svc>` row of `werkmeister pr gate` / `pr open` now runs the probe the service's `health_endpoint` names, the same one `feature status` runs on a forward: an HTTP GET for a path (passing below 500), the Redis or Postgres handshake for `redis` / `postgres`, and a TCP connect for `""`. A local datastore service (e.g. `postgres`, `health_endpoint: ""`) now passes the gate instead of failing with `GET http://localhost:<port> → unreachable`, and the row's message names the probe it ran (SW-938).

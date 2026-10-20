---
"werkmeister": patch
---

`werkmeister status` and the infra, k8s-forwards and Caddy health checks read containers from the Docker Engine API by compose label instead of shelling out to `docker compose ps` (SW-59). `status` no longer prints a `Running: docker compose … ps` line per feature, so `status --json` is valid JSON again, and it no longer generates the k8s-forwards override as a side effect.

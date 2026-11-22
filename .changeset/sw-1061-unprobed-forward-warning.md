---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister registry sync` and `werkmeister machine setup` (and `--check`) now list each forwarded service with no `health_endpoint` (SW-1061). Since SW-939 such a service is probed as `GET /health`, so a gRPC or raw-TCP one fails its probe and the k8s forwarder restarts its tunnel every 45 s. Set `health_endpoint: ""` on a non-HTTP service. The default is unchanged.

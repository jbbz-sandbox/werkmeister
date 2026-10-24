---
"werkmeister": patch
"werkmeister-mcp": patch
---

`werkmeister status`, the Workspaces pane and the dashboard show a stopped k8s-forwards container as neutral ("stopped — not needed by any running workspace") when no running workspace has a cluster-backed local service. Since SW-42 `up` starts the forwarder only for such workspaces, so on a werkmeister-only machine it is stopped by design. While a running workspace needs it, a stopped forwarder still shows red with the `docker restart sandbox-k8s-forwards` hint. `k8s-forwards-status` gains a `stopped` flag, and the infra tally leaves out a forwarder nothing needs, so infra no longer reads partial.

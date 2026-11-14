---
"werkmeister": patch
---

A local-only Caddy host (a service with no `remote_upstream`, such as docs-site) no longer silently serves the first running feature to a request that selects nothing it serves (SW-704). With no `X-Feature` header or cookie it still serves the first feature by name, now marked by an `X-Werkmeister-Served-By: <name> (fallback: no feature selected)` response header. A header or cookie naming no feature that serves the host gets a 404 pointing at `/__werkmeister`. Every feature-routed response names its feature in `X-Werkmeister-Served-By`. Hosts with a `remote_upstream` still default to the tunnel.

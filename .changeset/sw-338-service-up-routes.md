---
"werkmeister": patch
---

SW-338: `werkmeister feature up --service <svc>` now regenerates the Caddyfile and reloads Caddy after the service starts, so the feature cookie reaches this workspace's container instead of falling through to another workspace's upstream.

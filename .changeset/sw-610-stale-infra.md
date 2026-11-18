---
"werkmeister": patch
"werkmeister-core": patch
---

Shared infra made from an old checkout path is detected. A container made from another checkout's compose file is named, with `werkmeister infra up` as the fix, by `feature up`, `infra proxy-reload`, `feature status` and `infra status`. `infra up` now recreates those containers too, including one whose only drift is the files it was made from. Caddy counts as unhealthy when its `/__werkmeister` picker page is missing from its mount, which used to 404 on every routed host.

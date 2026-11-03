---
"werkmeister-core": patch
"werkmeister": patch
---

The generated `.werkmeister/werkmeister-context.md` now marks each host whose service has a `feature_router` with no remote upstream as answering only while a feature runs that service (in Quick Health Checks and Proxy Routing), and tells the reader to check `~/.werkmeister/infra/proxy/features.json` before reading a TLS reset (curl exit 35) with a healthy `w9r-caddy` as an outage.

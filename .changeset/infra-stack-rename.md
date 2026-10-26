---
"werkmeister-core": minor
"werkmeister": minor
---

SW-95: the shared-infra stack no longer says "sandbox". The compose project is `w9r-infra`, the containers are `w9r-caddy` and `w9r-k8s-forwards`, and Caddy's volumes are `w9r-infra_caddy-data` / `w9r-infra_caddy-config`. The dashboard's Jaeger and RedisInsight links point at `*.w9r-infra.orb.local`. On a machine still running the old `sandbox-infra` stack, the next `connect` / `up infra` takes it down first (its containers hold the names and ports 80/443 the new one needs) and then starts the renamed stack, so the proxy restarts once. `down infra` takes the old stack down too. Its volumes are kept unless you pass `--volumes`. Leftover `sandbox-infra_*` volumes can go with `docker volume rm`. An opted-in RedisInsight starts with empty settings, because its volume moves to the new project. Caddy's data is safe to lose: certs are bind-mounted from `certs_dir`.

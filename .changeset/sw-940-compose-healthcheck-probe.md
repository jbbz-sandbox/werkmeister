---
"werkmeister": patch
"werkmeister-core": patch
---

A service's compose healthcheck now runs the probe its `health_endpoint` names, the one the `pr gate` baseline row runs, and fails when it fails (SW-940). It ended `|| exit 0`, so a local datastore read healthy before it took connections and `depends_on` ordered nothing. `""` is a TCP connect (`nc`, else bash), `postgres` is `pg_isready`, `redis` is `redis-cli ping`, and a path is an HTTP GET that passes below 500. An image without the probe's tool still passes, as before. A dependency whose probe still fails after its start period and retries (about 6 minutes) now fails `up` for the services that depend on it.

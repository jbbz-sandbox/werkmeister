---
"werkmeister": patch
"werkmeister-core": patch
---

An `extra_services` sidecar's `health_endpoint` now reads as a service's does (SW-1056): `""` is a TCP connect, where it used to mean no healthcheck at all, so `depends_on: service_healthy` can order an app after a MySQL, MariaDB or memcached sidecar. `redis`, `postgres` and a path run the same probes a service runs (each passes when its tool is missing from the image), and an unset one is still the Redis probe.

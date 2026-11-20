---
"werkmeister": patch
---

An `extra_services` sidecar is no longer Redis-only (SW-933). It takes `health_endpoint` (`redis`, the default and today's `redis-cli ping`; `postgres` for `pg_isready`; an HTTP path; or `""` for no healthcheck), `environment` and `extra_volumes`, and `command` is now optional. So a postgres sidecar with a password, a database and a mounted init script can be declared in the registry instead of as a second full service.

---
"werkmeister-core": patch
---

Compose generation refuses a sidecar name that two services declare in `extra_services`, or that a service or setup service in the feature already has, naming both: each sidecar is its own compose service and container, so a repeated name wrote a duplicate key that `docker compose up` rejected (SW-1233).

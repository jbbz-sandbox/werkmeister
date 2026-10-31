---
"werkmeister": patch
---

SW-222: a workspace with no services now gets `services: {}` in its compose.yml instead of a bare `services:` (YAML null), so `docker compose` no longer rejects it with "services must be a mapping".

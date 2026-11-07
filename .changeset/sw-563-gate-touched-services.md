---
"werkmeister": patch
---

SW-563: when a changed file under no `path_mappings` or `no_service_paths` entry makes the pr gate test every service, the passing `tests` row now names it (`every service: no path_mappings or no_service_paths entry for <file>`), so the folder gets mapped instead of starting every container again. The werkmeister repo's own fragment maps `scripts/`, `bin/` and the root licence files to no service (the lint row already runs their checks), and `werkmeister-dashboard`'s `test:` now runs werkmeister-ui's tests too.

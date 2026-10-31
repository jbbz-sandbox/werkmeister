---
"werkmeister-core": patch
---

SW-299: the workspace lookup from a container's compose label gives its `docker ps` the teardown's 300 s limit, so a lookup starved on a loaded host no longer reads as "no workspace" (`pause` failed `NO_WORKSPACE`). Test-only: the forward-probe tests give healthy probes 30 s, and pause-resume's fake Engine keeps idle connections open across a blocked event loop.

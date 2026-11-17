---
"werkmeister-core": patch
---

A service whose volumes mount the docker socket or the werkmeister home (or a parent of either) no longer gets a pre-approved `docker exec <feature>-<svc> sh -c '<test>'` rule: its test code would run with the host's docker and the real `~/.werkmeister`. Those runs ask; `werkmeister pr gate` still runs them (SW-845).

---
"werkmeister": patch
"werkmeister-core": patch
---

`pr gate` / `pr open` (SW-734): a service the PR file's `skip_tests` names is no longer started, from `compose.gate.yml` or as the lint/release container, so the gate no longer waits for capacity for it or its install. The lint/release container is another repo service when one exists. The capacity-wait line now says that stopping the command ends the wait, and that the gate starts no `skip_tests` service.

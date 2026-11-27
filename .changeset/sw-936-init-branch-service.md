---
"werkmeister": patch
---

SW-936: `werkmeister workspace init` reads each worktree's own `.werkmeister/services.yaml` over the registry when it checks which repo owns a listed service, as compose generation already does, so a service a branch adds no longer gets a wrong "Unknown service(s) in workspace.yml" warning.

---
"werkmeister-core": patch
"werkmeister": patch
---

`werkmeister feature up` and `workspace init` now render a workspace's `compose.yml` with each of its repos' own `.werkmeister/services.yaml` fragment merged over the global registry, the way the pre-PR gate already tests a branch. A branch that changes a service's `command:`, image, setup or volumes runs that change in its feature containers before merge; other repos' services still come from the registry, which is left untouched (SW-337).

---
"werkmeister-core": patch
---

`werkmeister machine detect` no longer refuses to write a fragment because of a clash inside a repo this machine disabled. `validateFragment` leaves out the repos listed under `disabled_fragments` in `services.local.yaml`, as `werkmeister registry sync` does, and takes the overrides file as an optional `localPath`.

---
"werkmeister-core": patch
---

`werkmeister-context.md` § Test commands now counts the mounts a service gets from the branch's own `.werkmeister/services.yaml` and the workspace's `dev_links`, as the allow rules already did. A service whose only `~/.werkmeister` or docker-socket mount comes from `dev_links` now prints its test under `with-temp-home` instead of a bare `docker exec` (SW-872).

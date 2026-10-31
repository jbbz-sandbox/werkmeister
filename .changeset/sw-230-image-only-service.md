---
"werkmeister": minor
---

SW-230: a `services.yaml` service can be image-only: `image:` with no `repo:`, plus an optional `internal_port`/`port_offset` and `command`. `workspace init` accepts it (a service with neither a repo nor an image is still an unknown service), and the compose template renders it like an app service, with no repo mount, `working_dir` or build, and the image's own CMD unless `command` is set. A fixture workspace can now run a real `up` → `stop` → `down` on e.g. `nginx:alpine`. Declare it in the machine `services.yaml` or its overrides, not in a repo fragment.

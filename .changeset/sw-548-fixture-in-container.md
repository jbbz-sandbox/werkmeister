---
"werkmeister": patch
"werkmeister-core": patch
---

`.werkmeister/bin/with-fixture-workspace` now works inside a werkmeister container (`docker exec -w /app <container> <ws>/.werkmeister/bin/with-fixture-workspace …`): it runs the CLI at /app, where the container's node_modules is, instead of the host-path copy that failed `ERR_MODULE_NOT_FOUND: dockerode`. From a host checkout with no node_modules it exits 2 and names that form. Rerun `werkmeister workspace init` to regenerate the script.

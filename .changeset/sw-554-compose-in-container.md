---
"werkmeister-core": patch
"werkmeister": patch
---

SW-554: a compose regeneration (`feature up`, the pr gate's `startService`, `workspace init`, the gate's compose.gate.yml) run inside a container now refuses with `INSIDE_CONTAINER` instead of writing the container's `/app` paths into the host-read file, which made the install run an empty script and exit 0. Docker's `/.dockerenv` is the test, so unsetting `WERKMEISTER_FEATURE` no longer gets past it; a relocated `WERKMEISTER_CONFIG_FILE` (every test and fixture) still writes.

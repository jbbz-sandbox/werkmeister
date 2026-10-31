---
"werkmeister-core": patch
---

SW-259: under `node --test`, the Docker client gets a dead socket unless the test file called `useDockerEngine()` (fixtures.mjs), so a core test can no longer read the host engine's containers by accident, even when `DOCKER_HOST` is set. Outside a test run nothing changes.

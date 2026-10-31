---
"werkmeister-core": patch
---

SW-257: taking down the pre-rename `sandbox-infra` stack no longer gives up when the `docker ps` / `docker volume ls` check for held containers takes over 10 s on a loaded host; the check now waits as long as the teardown does, so `infra start` and `down` still free the old stack's ports and volumes.

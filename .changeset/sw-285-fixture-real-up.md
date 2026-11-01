---
"werkmeister": patch
---

SW-285: `with-temp-home` keeps `DOCKER_CONFIG` at the caller's `~/.docker`, so `docker compose` works under a temp HOME; the workspace lookup compares real paths, so a `/var/…` workspaces root matches a `/private/var/…` cwd on macOS; and the cli validate text gives the exact `pwd -P`, `init --feature`, `feature up|stop|down <name>` sequence.

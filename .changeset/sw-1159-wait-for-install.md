---
"werkmeister-core": patch
---

`feature up` and `feature up --service` no longer give up when compose's 20-minute wait runs out while a fresh worktree's install is still building. They say they are waiting for the setup container, wait for it to exit, then start what compose left Created. They give up after 10 minutes with no new line in its log, naming the container and `docker logs`. An install that fails still fails the start (SW-1159).

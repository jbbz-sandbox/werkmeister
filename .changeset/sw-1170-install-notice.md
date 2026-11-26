---
"werkmeister-core": patch
---

A `feature up` or `feature up --service` still waiting on a setup container after 30 s names it: `Installing dependencies in <ws>-werkmeister-install (a fresh worktree takes 10-25 min)`, with the `docker logs -f` command to follow it. A daemon timeout while allocating the slot now says the install is still running and to rerun once it exits, instead of reading as a bare failure (SW-1170; the daemon's slow answer is SW-1235).

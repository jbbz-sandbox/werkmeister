---
"werkmeister-core": patch
---

The reload step of generated stage contracts no longer forbids `werkmeister up` outright (SW-135): if the container is not running, the agent runs `werkmeister up` once first, because a never-started container has no `pnpm` and `docker restart` on it loops on "pnpm: not found". `docker restart` is only for reloading a running container. Applies to the feature `03_implement`, bugfix `03_exercise` and refactor `02_implement` contracts of new workspaces.

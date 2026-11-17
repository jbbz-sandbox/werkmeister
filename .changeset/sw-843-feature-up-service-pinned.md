---
"werkmeister-core": patch
---

Autonomous workspaces no longer pre-approve `werkmeister feature up --service:*` or `feature up <feature> --service:*`, which let an agent start another workspace's service (`feature up --service x <other>`, or `-w <path>`). Both forms are now allowed exactly, once for each of the workspace's own services (SW-843).

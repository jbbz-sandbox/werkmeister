---
"werkmeister": patch
"werkmeister-core": patch
---

The `budget` tool and `werkmeister budget status` read the Docker VM's core count once per process on macOS and Windows (SW-1028), not with a `docker run` on every call. A pane polling the tool every 30 s no longer starts a container per poll. A VM resized while the daemon runs keeps its old count until the daemon restarts.

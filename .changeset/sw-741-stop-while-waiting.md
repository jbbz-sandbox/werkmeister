---
"werkmeister": patch
---

`feature up --help` and `internal wait-load --help` say which of a workspace's containers keep running while it waits: a queued whole `up` runs none, a `--service` or gate start in an autonomous workspace stops its set and starts it again once admitted, and the host-load waits stop and pause nothing. Stop is used rather than pause because a paused container keeps its memory and still holds its queue room. The `wait-load` help no longer says macOS waits on memory only: it reads the Docker VM's load (SW-741).

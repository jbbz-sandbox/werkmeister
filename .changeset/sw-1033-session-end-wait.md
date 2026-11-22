---
"werkmeister": patch
"werkmeister-core": patch
---

Closing a Claude session no longer takes a waiting workspace out of the capacity queue (SW-1033). The SessionEnd auto-stop (`auto_stop`) now skips a workspace whose whole start is queued: its containers are already stopped, and the plain stop it ran dropped the queued start and its `waiting.json` (SW-1017).

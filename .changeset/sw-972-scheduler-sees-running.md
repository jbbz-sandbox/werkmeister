---
"werkmeister": patch
---

The scheduler sees running workspaces again (SW-972). Its Docker inspect format failed on any container with no `docker exec` in flight, so admission read "docker unavailable" and admitted every start without counting what was already running. The daemon also dropped the `gate` flag on a queued start, so a gate that released its containers to wait lost its place at the front of the queue.

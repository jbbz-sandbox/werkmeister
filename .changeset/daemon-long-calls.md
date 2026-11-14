---
"werkmeister": patch
---

A grant, admission or other daemon call that runs longer than 5 minutes no longer fails with `DAEMON_TIMEOUT` while the daemon is still running it (SW-700). The CLI's `fetch` stops waiting for response headers, or for a silent body, after 300 s, whatever timeout the caller passes. The daemon's `POST /api/tool` now sends headers at once to a client that sends `x-werkmeister-stream: 1`, writes a space every minute, and puts the status in the JSON body. A call that outlasts its own timeout (15 minutes for a grant or admission) is still `DAEMON_TIMEOUT`. Older clients, including an older VS Code extension, still get status codes, and a CLI talking to a daemon that has not restarted yet still works.

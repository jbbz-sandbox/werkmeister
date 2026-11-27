---
"werkmeister": patch
---

SW-1137: a workspace's managed `.gitignore` now lists the runtime files the agent-state code writes (`.werkmeister/last-stop.json`, `paused.json`, `resume-nudge.json`, `waiting.json` and leftover `*.tmp` files), so an idle stop, a pause or a capacity wait no longer leaves the record branch dirty. Existing workspaces pick the rules up on their next `werkmeister feature up`.

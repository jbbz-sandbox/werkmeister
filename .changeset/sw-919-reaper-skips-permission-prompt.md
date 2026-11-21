---
"werkmeister": patch
---

The idle reaper no longer stops a workspace whose session sits on a tool-permission prompt (SW-919). The prompt is mid-turn, often on a `docker exec` into the same container, so stopping it made the approved command fail with `container … is not running`. A question or plan prompt open for `idle_stop_minutes` still counts as waiting on a person and is reaped while others queue.

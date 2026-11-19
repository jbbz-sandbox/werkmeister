---
"werkmeister": patch
---

Preemption no longer stops a feature whose session shows a tool-permission prompt: that prompt is mid-turn (often for a `docker exec` into the same container), so it ranks like the turn it sits in, working in an autonomous workspace and a person's otherwise. A question or plan prompt still counts as waiting on a person (SW-910).

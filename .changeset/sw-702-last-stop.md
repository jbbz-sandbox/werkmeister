---
"werkmeister-core": patch
---

When werkmeister stops a workspace on its own (preempted, or idle), it records why in `.werkmeister/last-stop.json`, and the "Capacity freed" nudge that brings the session back says who stopped it and which commands that killed (SW-702).

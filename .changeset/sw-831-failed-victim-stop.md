---
"werkmeister-core": patch
---

SW-831: when preemption fails to stop a victim and some of its containers still run, the victim is no longer queued, so its agent's container and test commands are not held over live containers. The start that asked still waits at the head of the queue. A victim with nothing left running is queued to come back, as before.

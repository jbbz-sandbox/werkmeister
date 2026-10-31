---
"werkmeister-core": patch
---

SW-246: the scheduler writes a feature's `waiting.json` before `queue.json` when it queues it (`admit` waiting, or preempted), so a workspace with no `.werkmeister/` gets the ENOENT error and stays out of the queue instead of showing as waiting in `status` with a session that never learns it is queued.

---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity hook (SW-713): a session is no longer held by "Waiting for capacity" after its feature has left the queue. The hook clears a leftover waiting file instead of denying every tool call, and `feature restart` of a queued feature takes it out of the queue, so its running containers no longer leave the session stuck.

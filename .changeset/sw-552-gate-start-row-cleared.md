---
"werkmeister": patch
---

SW-552: a `start <svc>` row the pr gate failed on capacity no longer fails the gate when the gate's later on-demand start of the same service succeeds in the same run; the row reads `started on the second attempt` with the first error. The capacity message has named the workspaces holding the room since SW-540.

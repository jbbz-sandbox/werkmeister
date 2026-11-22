---
"werkmeister-core": patch
---

`werkmeister feature stop` and `feature down` now take a start that waits for capacity out of the queue (SW-1017); a stop of a start that never ran says it left the queue and exits 0, rather than "not running". A `feature up --service <name>` while the whole feature waits replaces that wait and starts just that service, rather than failing with "waiting for capacity". Preemption, the idle reaper and a gate's own release still keep a feature's place.

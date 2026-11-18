---
"werkmeister": patch
"werkmeister-core": patch
---

A feature with a `docker exec` running in its containers (a session's test run, not only the gate's) is busy: preemption never picks it and the idle reaper never stops it. `budget status` shows it as `run in flight`. When werkmeister does stop a workspace on its own (preempted, or idle), its session's nudge names each command the stop killed and says to rerun it (SW-856).

`with-fixture-workspace --running` takes an optional 6th column, the running `docker exec`s, so an exercise can show a busy holder.

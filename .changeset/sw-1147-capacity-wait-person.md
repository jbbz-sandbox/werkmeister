---
"werkmeister": patch
---

SW-1147: a capacity wait no longer waits out its time when only a person can free the room. When a start can fit only if a feature that is waiting on a person with a run in flight stops, the service starts of `pr gate`, `pr open` and `feature up --service` fail `NO_CAPACITY` (exit 75) at once. Preemption and the idle reaper never take such a feature. The message names each blocking feature and the step that frees it: answer its question, or stop it from the pane (`werkmeister feature stop <name>`). A queued plain `feature up` names them the same way. A holder whose run can finish, or one waiting on a person with nothing running, still waits as before. `with-fixture-workspace --running` takes a 7th column, `asking` (`0` or `1`), which parks that holder's session on a question.

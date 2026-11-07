---
"werkmeister": patch
---

SW-540: the scheduler now admits on-demand service starts. Starting a service (the pr gate's starts, `feature up --service`) asks for that service's CPUs and memory, plus the install it depends on, measured against what Docker shows running. When it doesn't fit, the start waits in the queue with its position on the card ("waiting for capacity"), checks every 15 s for up to 10 min, then fails with `NO_CAPACITY` naming what holds the room. It never preempts another workspace. A queue entry whose poll stopped for 60 s is dropped. `with-temp-home` now exits 75 without running its command when host load is still over `budget.host_load` after its 90 s wait.

---
"werkmeister": patch
---

`werkmeister feature up` starts a container compose left Created when its 20-minute limit ran out, and carries on (SW-973), instead of failing with the container sitting in Created. It leaves dependents of a failed container alone, and names a container that still will not start with the `docker start` that starts it.

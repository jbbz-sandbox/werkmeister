---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-763): the "waiting for capacity" and exit-75 messages now say what the start needs against what is free in the budget (`this start needs 4 CPUs, 1.0 GiB; free 3 CPUs, 5.8 GiB of the budget's 8 CPUs, 6.8 GiB`), so a request too big for the host reads apart from a busy one and can be retried with `--service`. The wake on an idle host comes from the `pr watch` grant pass, which SW-737 made work.

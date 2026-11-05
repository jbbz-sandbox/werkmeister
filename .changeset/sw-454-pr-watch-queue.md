---
"werkmeister": patch
---

`pr watch` now wakes the session when an open PR's merge-queue run fails. GitHub drops the PR from the queue while its head checks stay green, so the check rollup never showed it; the wake names `merge queue (<workflow>)` and quotes the failing run's log (SW-454).

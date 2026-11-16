---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-745): a running `pr gate` / `pr open` is never preempted. The gate marked itself busy only when it started a container or ran a row, so a test row longer than `idle_stop_minutes` read as not busy, and a queued start could stop its containers mid-run (exit 137, reported as test failures). The gate now refreshes that mark every minute while it runs. With `idle_stop_minutes: 0` a gate also counts as busy.

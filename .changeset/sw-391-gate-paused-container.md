---
"werkmeister": patch
---

`pr gate` with a paused container now fails with a clear ✗ "paused: press ▶ Resume on its card, then rerun" row instead of a lint/test failure from `docker exec`, and no longer ticks the paused container as running (SW-391).

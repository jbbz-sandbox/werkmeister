---
"werkmeister": patch
---

A workspace card no longer reads "Queued for CPU" while only one of its service starts waits for capacity (SW-569). The session keeps working during that wait, so the card shows what it is doing: Running tests, Running Bash, Thinking or Needs you. "Queued for CPU" is now kept for a whole-feature queue, where the session itself is held.

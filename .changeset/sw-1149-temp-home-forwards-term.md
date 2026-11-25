---
"werkmeister": patch
---

SW-1149: a signal to `with-temp-home` now reaches the command it wraps: it ends that command and removes the temp HOME, instead of waiting for the command to finish on its own. The command still reads the caller's stdin.

---
"werkmeister-core": patch
"werkmeister": patch
---

SW-526: the generated ICM contracts' test step gives the background log pattern without a trailing `echo "exit $?"` (read the exit code from the job's completion notice) and keeps the echo for a foreground call.

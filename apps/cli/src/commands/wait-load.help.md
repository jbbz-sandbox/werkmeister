## Description

Waits while the host's 1-minute load is above `budget.host_load` in `~/.werkmeister/config.yaml` (default: 2 × CPUs; `0` turns it off), for up to 30 minutes, then returns and says so: the same wait `pr gate` and `pr open` run before each check. `.werkmeister/bin/with-temp-home` runs it before its command; `WERKMEISTER_NO_WAIT=1` makes the wrapper skip it.

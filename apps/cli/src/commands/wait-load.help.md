## Description

Waits while the host's 1-minute load is above `budget.host_load` in `~/.werkmeister/config.yaml` (default: 2 × CPUs; `0` turns it off), for up to 90 seconds (under an agent's 2-minute Bash timeout), then returns and says so: the same wait `pr gate` and `pr open` run before each check, but they share a 10-minute budget. `.werkmeister/bin/with-temp-home` runs it before its command; `WERKMEISTER_NO_WAIT=1` makes the wrapper skip it.

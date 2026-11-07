## Description

Waits while the host's 1-minute load is above `budget.host_load` in `~/.werkmeister/config.yaml` (default: 2 × CPUs; `0` turns it off), for up to 90 seconds (under an agent's 2-minute Bash timeout). If load is still over the limit then, it exits 75 and the wrapper stops without running its command (SW-540). On macOS it returns at once: its load average counts idle daemons and is never the Linux VM's, so it is no signal to wait on (SW-556). `.werkmeister/bin/with-temp-home` runs it before its command; `WERKMEISTER_NO_WAIT=1` makes the wrapper skip it.

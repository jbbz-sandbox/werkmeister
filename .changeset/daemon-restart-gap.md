---
"werkmeister": patch
---

The CLI now waits out the daemon's own restart instead of falling back to in-process scheduling (SW-614). The daemon restarts itself whenever its build changes, and during that gap a call was refused or reset. The CLI now retries for up to 15 s; after one wait gives up, later calls in that process try once. When it does fall back, the warning names the cause: `nothing is listening, the daemon is not running`, `the daemon reset the connection while exiting or restarting`, or `the port is held by something that is not the werkmeister daemon`. A call the daemon accepted but answered late now fails with `DAEMON_TIMEOUT` and is no longer run a second time in the CLI. `werkmeister machine setup --check` now reports a daemon that doesn't answer: on macOS `installed, but nothing answers at <url>: the daemon is not running`, and elsewhere `not on macOS and nothing answers at <url>`.

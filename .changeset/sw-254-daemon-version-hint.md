---
"werkmeister-core": patch
---

SW-254: a daemon older than the CLI no longer fails with only `Tool scheduler not found`. When the daemon answers that it has no tool the CLI called, the error says the daemon is older than the CLI and names `werkmeister daemon restart` (code `DAEMON_STALE`). Other daemon errors are unchanged.

---
"werkmeister": minor
---

The host daemon now knows which build it loaded (SW-306). `werkmeister daemon status` shows it, or `stale (loaded <x>, on disk <y>)` after a rebuild or upgrade; the CLI warns once per run when it reaches a daemon on another build; and under launchd the daemon restarts itself on the new build once no call or queued feature is in flight.

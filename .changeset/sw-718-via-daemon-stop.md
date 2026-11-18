---
"werkmeister": patch
"werkmeister-core": patch
---

`feature stop --via-daemon` (the SessionEnd auto-stop) calls the daemon even when the CLI can't find its own daemon build for the build header. The lookup failure used to throw before the request, and the error was dropped, so the stop did nothing and exited 0. It now sends no header, and any daemon error other than "not running" is printed.

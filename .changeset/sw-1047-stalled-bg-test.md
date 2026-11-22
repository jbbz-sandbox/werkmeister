---
"werkmeister": patch
"werkmeister-core": patch
---

A background test or gate run (`run_in_background`) longer than 30 minutes keeps reading `Running tests` (or `Running in background`) instead of dropping to idle, and gets the same `overrides.stalled_tool_minutes` limit as a foreground tool call, 90 when unset (SW-1047). A hung background run reads `stalled: idle` past that limit; 30 minutes later the card takes it for a missed exit and stops showing it.

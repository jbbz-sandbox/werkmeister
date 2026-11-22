---
"werkmeister": patch
"werkmeister-core": patch
---

A long tool call, such as a 35-minute `pr gate` or test run, no longer reads `stalled: idle` at 30 minutes (SW-1037). Claude writes nothing to the transcript during one tool call, so while a foreground tool call runs the idle limit is `overrides.stalled_tool_minutes` in `~/.werkmeister/config.yaml`, 90 when unset. A hung run still reads stalled after that.

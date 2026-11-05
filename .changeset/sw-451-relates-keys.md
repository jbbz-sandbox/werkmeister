---
"werkmeister": patch
---

SW-451: `werkmeister issue create --relates` refuses a value that is not exactly one issue key (`SW-29x`, `SW-292,SW-263`) before anything is filed. Only the key's format is checked, not that the issue exists.

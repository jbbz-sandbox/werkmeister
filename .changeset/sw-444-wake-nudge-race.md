---
"werkmeister": patch
---

A wake `pr watch` holds for an open session is now kept in `.werkmeister/wake-nudge-<session>.json`, and the hook claims it by renaming the file before reading it. Two hooks firing at once no longer both deliver it, and a message `pr watch` adds during delivery is no longer dropped (SW-444). A wake still held in the old `wake-nudge.json` at upgrade is not delivered.

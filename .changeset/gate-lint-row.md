---
"werkmeister": minor
---

`werkmeister pr gate` runs a repo's lint/format command, set by `lint:` in its fragment's `repo:` block, as a `lint` row; a failure blocks `pr open` (SW-133).

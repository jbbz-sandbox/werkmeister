---
"werkmeister": patch
---

The card's `Running in background: …` label names a werkmeister command only at the start of a command, and takes a second word only for a command group: `git -C werkmeister log` reads as that command, and a command's argument is no longer read as its second word (SW-690).

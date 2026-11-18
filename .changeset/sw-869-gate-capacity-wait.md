---
"werkmeister": patch
"werkmeister-core": patch
---

The services `pr gate` and `pr open` start now share one 30-minute wait for room in the budget, keeping their queue place, instead of 10 minutes each that ended by dropping the place (SW-869).

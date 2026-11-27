---
"werkmeister-core": patch
---

SW-1189: `pr status` and each `pr watch` poll check whether a PR head's `ci.result` is already logged by reading only the month file of the last check's end, where that line is written, instead of rereading the whole metrics log (and its git calls) on every poll.

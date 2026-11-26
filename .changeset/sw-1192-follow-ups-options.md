---
"werkmeister-core": patch
---

The `pr gate` follow-ups check no longer reads a decision's `Options:` list. A decided "defer, no ticket" item whose only "follow-up" wording sits in an option nobody chose now passes. A chosen answer that promises a follow-up with no issue key still fails (SW-1192).

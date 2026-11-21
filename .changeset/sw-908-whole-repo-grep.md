---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce contract's caller step now finds the call sites, and any help, docs, man pages, snapshots or expected-text tests that restate the rule being changed, with one `git grep` across the whole repo rather than one package, and records the command (SW-908).

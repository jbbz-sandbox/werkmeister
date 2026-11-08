---
"werkmeister": patch
---

SW-564: the bug-fix and incident `01_reproduce` contract has a new step 7: when the root cause is a permission rule, step 4 lists every source of a matching rule (builders, rules derived from registered commands, rules kept in existing workspaces, a headless wake's tool lists) and the failing test probes each one. The repro file now holds steps 1–7. New workspaces get the text.

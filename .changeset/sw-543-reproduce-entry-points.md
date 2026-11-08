---
"werkmeister": patch
---

SW-543: the bug-fix and incident `01_reproduce` contract now says that when the fix belongs in shared code, call sites are listed through every helper or entry point that reaches it, not one argument shape, and the search commands used are recorded in `repro.md`. New workspaces get the text; an existing one keeps its copy.

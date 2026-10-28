---
"werkmeister-core": patch
---

The generated ICM `01_reproduce` and `01_research` contracts ask each decision that renames, keeps or removes a name, fallback or alias for its definition site and the `git log -S` commit that introduced it, and list "remove" as an option when that commit marks a transition or legacy alias (SW-123).

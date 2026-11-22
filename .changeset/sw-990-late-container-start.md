---
"werkmeister": patch
"werkmeister-core": patch
---

The feature `03_implement` contract's fail-first step (SW-990) writes the change and its tests with no container and starts it at the first fail-first run: park the change in a WIP commit, check out the unfixed source, `feature up` and run the new tests, then restore the change, build and test; `feature stop` when a long stretch of editing follows.

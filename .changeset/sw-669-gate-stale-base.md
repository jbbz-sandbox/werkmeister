---
"werkmeister": patch
---

`werkmeister pr gate` and `pr open` now fetch `origin/<base>` before the tests. If a branch that isn't pushed yet is behind it, a `base` row fails and names how many commits behind it is and the `git -C <repo> rebase origin/<base>` to run. No lint or test row runs, and nothing is pushed, so a PR no longer opens conflicting after the gate ran on a stale base. A branch that's already pushed passes with a note pointing at `pr watch` and rule 5's force-with-lease hand-off. The ICM propose stage and `_shared/pr-rules.md` say to rebase before the first push. `with-fixture-workspace --behind` seeds a branch behind `origin/main`.

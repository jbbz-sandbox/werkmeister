---
"werkmeister": patch
"werkmeister-core": patch
---

The ICM bug-fix exercise stage (after the review's fixes) and the feature and refactor implement stages (after a fix to the post-exercise review) rerun `werkmeister pr gate --tests` instead of one service's test command. These edits come after the gate's run, and the gate retests every service the diff touches, so a docs fix no longer skips docs-site's tests and fails the first `pr open`.

---
"werkmeister": patch
---

`werkmeister pr status` and `pr watch` compare an open PR's head with the worktree's branch. When the branch holds commits the PR doesn't (a fixup nobody force-pushed), they warn and print the push command. After merge, the PR file records the PR head as `head_sha:`. While the worktree is still on that branch with commits past it, the PR stays `merged` with a "not shipped yet" line naming `werkmeister pr new`, and its issues don't move to Done (SW-943).

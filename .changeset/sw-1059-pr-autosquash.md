---
"werkmeister": minor
"werkmeister-core": minor
---

New `werkmeister pr autosquash [repo]`: folds each `fixup!` commit into its ticket's commit with `git rebase --autosquash` onto the merge-base with `origin/<base>`, a no-op editor and hooks off, in the workspace's own worktrees. It refuses another worktree or branch, a dirty tree, a merge commit from the base and a branch already on origin. The grouped ICM contracts name it in place of the raw rebase, which auto mode refused both ways it can run non-interactively (`git -c` is denied, `GIT_SEQUENCE_EDITOR=` is refused), and every ICM run pre-approves it (SW-1059).

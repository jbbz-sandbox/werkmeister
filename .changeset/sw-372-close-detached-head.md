---
"werkmeister": patch
---

`workspace close` passes a clean code worktree left on a detached HEAD after the merge (its branch deleted, no untracked files, nothing missing from origin's default branch) with "nothing to hand off" instead of refusing with "no branch to push (detached HEAD)" (SW-372). A detached worktree that is dirty or holds a commit not on origin still refuses, and the message now says why.

---
"werkmeister-core": minor
"werkmeister": minor
---

SW-103: a workspace can create and track more than one PR per code repo. `werkmeister pr new <worktree> --slug <slug>` cuts a fresh branch from base after that worktree's PR merged and writes a draft `pr-<worktree>-<slug>.md` with a `worktree:` field; gate, open, status, adopt, close-out and the workspaces pane handle every PR file of a worktree. `pr open` refuses a branch name an earlier merged PR of the same worktree used. Existing `pr-<repo>.md` files behave as before.

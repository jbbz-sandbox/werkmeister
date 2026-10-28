---
"werkmeister": patch
---

A new workspace's record branch and code worktree branches track their own `origin/<user>/<workspace>` instead of `origin/main` (SW-146), so the first plain `git push` creates the remote branch instead of failing on a push.default mismatch. Existing workspaces are not migrated; `git push -u origin HEAD` still fixes one.

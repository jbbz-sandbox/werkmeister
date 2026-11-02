---
"werkmeister-core": patch
"werkmeister": patch
---

A workspace whose worktree is the werkmeister repo now pre-approves the built CLI run through its temp-HOME wrapper (`Bash(<workspace>/.werkmeister/bin/with-temp-home <worktree>/apps/cli/werkmeister:*)`), so the auto-mode classifier no longer refuses a CLI-level exercise. The bare wrapper is still never allowed. Existing workspaces pick the rule up with `werkmeister machine migrate`.

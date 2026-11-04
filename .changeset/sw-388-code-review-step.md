---
"werkmeister-core": minor
"werkmeister": minor
---

SW-388: ICM feature and refactor implement stages, and the bugfix/incident exercise stage, end with a code review step. A fresh subagent runs `ponytail:ponytail-review` over each code worktree's uncommitted diff, every Must fix is fixed in place, and the stage writes `output/review.md` with a PASS/FAIL row per worktree. The bugfix/incident exercise stage now loads the coding standards, since the review may change code there. The PR gate has a new `review` check: it fails when `review.md` is missing or has a row that is not `PASS`, and `skip_review: <reason>` in the PR file skips it. Existing workspaces are unaffected: the gate asks for a review only when a stage's `CONTEXT.md` names `review.md`, which happens once `werkmeister workspace init` re-renders the contracts (init rewrites every stage contract).

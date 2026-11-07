---
"werkmeister-core": minor
---

SW-478: an approval given at the root `/check-in` now reaches a waiting workspace as a file it acts on, with no second prompt. The ICM spec, implement and review stages (feature `spec.md` and `review.md`, bugfix `fix.md` and `review.md`, refactor `review.md`) now start their output with `status: proposed`. Their human check flips it to `decided`, and the router enters the next stage when it reads `decided`, the way 01_research already did. The `check-in` tool's `gates` also lists a `pr-*.md` at `status: draft`. The `check-in` skill ships in the werkmeister plugin. Its gate-file row now covers PR approvals and stage "proceed"s, which before went back to the person to type again, and the reverted SW-309 pane-form row is gone. After upgrading, remove any hand-copied `check-in` skill from your workspaces root's `.claude/skills/`.

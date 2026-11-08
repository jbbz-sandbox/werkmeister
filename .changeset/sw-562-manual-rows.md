---
"werkmeister": patch
---

SW-562: the ICM stages that write `exercise.md` now tell the agent to ask the person for each MANUAL row's result (pass / fail / not run) before asking for approval, and to record it; an approval that skips this keeps the rows MANUAL and the PR file says why. New workspaces get the text.

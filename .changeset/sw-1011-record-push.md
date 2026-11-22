---
"werkmeister-core": patch
---

The ICM `04_propose` contract no longer asks the agent to push the record branch (SW-1011): `werkmeister pr push` refused there before a PR was open, so runs fell back to an un-pre-approved `git push`. The step now says to commit the record and leave the push to `werkmeister pr open`. Rule 1 of the PR rules and the workspace `CLAUDE.md` router say the same: `pr open` and `workspace close` push the record.

---
"werkmeister": patch
"werkmeister-core": patch
---

SW-890: `werkmeister pr push` leases on the PR head the conflict wake saw, not on `origin/<branch>` as last fetched, so a full `git fetch` after a reviewer's commit can no longer let the force-push drop it. `pr watch` records that head as `conflict_head:` in the PR file beside `notified_conflict`, keeps it until the PR settles or the next conflict wake, and wakes again for a conflict flagged before this release (which has none). `pr push` refuses when it is missing, when origin's branch is no longer it, or when the local branch never held it (its reflog), so a commit pushed to the PR before the conflict isn't dropped by the rebase either; it records the head it pushed. Rule 5 and the conflict wake message say so; after an "origin moved" refusal the agent rebases keeping the new commits and hands the push to the person.

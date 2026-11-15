---
"werkmeister": patch
"werkmeister-core": patch
---

SW-736: `04_propose` step 2 now runs the release check after the commit. A check that compares the branch with its base in git history (such as `changeset status --since`) does not see an uncommitted release entry.

---
"werkmeister-core": patch
---

`pr status` and `pr watch` passes on one workspace now run one at a time, so a PR that merges while both run writes one `pr.merged` (and `release`) metrics line and moves its issue once.

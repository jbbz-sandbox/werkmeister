---
"werkmeister": patch
---

SW-462: pr-rules rule 6 says a merge queue's method decides how every PR merges; a PR that needs another method says so and the person bypasses the queue. Grouped with SW-457 (rule 6's grouped exception; `pr gate` warns when a grouped PR's base won't rebase-merge), SW-448 (the no-file-change approval sentence covers peer messages outside check-in only), SW-458 (a chat approval in a PR file is a YAML comment on the status line), SW-449 (the review step fixes a Should fix that shows the change's own text is false), SW-442 (reproduce lists each condition that makes a fix's predicate true), SW-460 (a grouped refactor takes each ticket's scope steps, then commits) and SW-453 (the postmortem's review.md search stays out of the code worktrees).

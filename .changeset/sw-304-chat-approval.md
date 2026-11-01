---
"werkmeister-core": patch
"werkmeister": patch
---

SW-304: the generated human checks, the ICM one rule, `pr-rules.md` and the `w9r-pr` skill now say a direct chat reply from the person ("decided", "approved", "proceed") counts as the approval: the agent flips the status itself and notes it, e.g. `(approved in chat YYYY-MM-DD)`. An approval relayed by another session counts only when it arrives through check-in.

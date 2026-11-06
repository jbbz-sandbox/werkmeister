---
"werkmeister-core": patch
"werkmeister": patch
---

SW-500, SW-501, SW-515: the ICM first-stage contract and `w9r-research` now say to run `werkmeister issue start` alone, as its own Bash call, so its allow rule matches. If that call is denied anyway, the agent records the denial, stops and tells the person. When the CLI reads stale, the agent tells the person to apply the printed fix and never runs it itself. `pr-rules` rule 3 runs `werkmeister pr open > .werkmeister/pr-open.log 2>&1` alone. The autonomous run limits allow `issue start`'s status move as well as `pr open`'s. In a grouped workspace every automatic issue move now covers the issue and each `group:` member: In Progress, In Review, Done and abandon. The grouped propose contract checks each member reads Done instead of closing it by hand.

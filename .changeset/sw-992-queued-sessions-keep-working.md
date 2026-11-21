---
"werkmeister": patch
---

Queued sessions keep working, and an idle VM no longer queues workspaces (SW-992). A capacity wait denies only container and test commands and no longer ends the turn; `werkmeister feature up` is no longer held, so a queued session can ask again after the budget grows; and the workspaces pane keeps a grant notice it failed to send. CPUs have no default budget limit any more: a CPU limit is a cap, not use, and measured host load already gates installs and test runs. `budget.cpus` still caps the sum when set. A setup whose install stamp is current is no longer priced.

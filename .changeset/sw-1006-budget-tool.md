---
"werkmeister": minor
"werkmeister-core": minor
---

New `budget` MCP tool (SW-1006): the scheduler's budget, slot leases, what each running feature holds and what each waiter needs, the same object `werkmeister budget status --json` prints, so the VS Code view and the /workspaces pane can read it from the daemon. A per-workspace token may call it, like `resources`. The CLI and the tool share one read, `budgetStatus()` in `werkmeister-core/budget_status`.

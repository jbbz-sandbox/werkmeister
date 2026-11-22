---
"werkmeister": minor
"werkmeister-core": minor
---

The metrics event log records questions to the person (SW-776): `ask` when a session calls AskUserQuestion, ExitPlanMode or Desktop's wrap_up with an ask, and `answer` with `waited_s` when that ask's own tool returns (or, for a wrap_up ask, at the next prompt). Other tool calls write nothing.

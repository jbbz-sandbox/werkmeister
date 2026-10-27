---
"werkmeister-core": minor
"werkmeister": minor
---

SW-104 ready work: `werkmeister issue ready [--project <name>] [--json]` lists a project's open work in priority order, from its board's ready column in board rank when it has a board, else the scope's open issues. Issue trackers gain `listReady(board?)`. The `next-wave` skill moves into the werkmeister plugin and reads its tickets from `issue ready` on a machine with projects.

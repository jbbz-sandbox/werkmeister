---
"werkmeister": patch
"werkmeister-core": patch
---

The dashboard has a Flow tab (SW-782): the flow board from the `metrics` tool, four columns with WIP counts, each card's stage, age and current wait, red once older than its column's p90, with 7d / 30d / 90d / All ranges. A card opens its workspace's timeline (stages, waits, gate runs, PR) and session rows; a session row opens the chat panel on that session. The `metrics` tool takes an optional `workspace` and then also returns that workspace's run as `timeline`.

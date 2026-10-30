---
"werkmeister-core": minor
"werkmeister": minor
---

SW-206: `werkmeister close-out` (shipped and `--abandon`) writes `usage.md` and `usage.json` into the workspace record before the folder is removed, committed and pushed with `closeout.md`. They hold token totals by model, the USD estimate, per-session rows (first and last turn, turns, models), wall-clock time, approximate per-stage timing, and the run's werkmeister version and commit, model, autonomous setting and ticket. `closeout.md` gets a one-line `Usage:` summary. A retry after a failed removal keeps the first snapshot; a workspace with no transcripts still gets one that says so. The `workspace-usage` MCP tool's sessions gain `firstTurn`, `lastTurn`, `turns` and `models`.

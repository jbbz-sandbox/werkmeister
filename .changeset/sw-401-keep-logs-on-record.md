---
"werkmeister": patch
---

The workspace record keeps the gate and pr-open logs: `.gitignore` no longer ignores `gate-*.log` and `pr open` commits them with `pr-open.log` (SW-401). Existing workspaces keep their old ignore line.

---
"werkmeister": patch
---

A workspace's logs go in `.werkmeister/logs/`, so `.werkmeister/` holds only state and config: the gate's per-row logs (`gate-<repo>-<row>.log`), and the `pr open` / `pr gate --tests` redirects that `pr-rules.md` gives (`logs/pr-open.log`, `logs/gate-run.log`). `workspace init` creates the folder, and so does a contract sync that rewrites an ICM workspace's `pr-rules.md`. `pr open` commits everything in it to the record, plus the loose logs a workspace initialised before this change still writes (SW-1091).

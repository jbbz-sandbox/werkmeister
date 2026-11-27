---
"werkmeister": patch
---

SW-1085: `werkmeister issue start <ref>` now starts that issue instead of ignoring the ref, and `issue start <ref> --attach` records it as the workspace's issue in `.werkmeister/workspace.yml` without rerunning `workspace init` or touching `stages/`. With no ref and no workspace issue it warns instead of printing `[ok] Issue: no issue`. An autonomous workspace pre-approves only the bare `issue start`: a ref or `--attach` asks the person.

---
"werkmeister-core": patch
---

SW-829: `pr gate` (and so `pr open`) adds a `group` row to a grouped workspace's gate. It warns about each `group:` member whose key is in no commit subject in `origin/<base>..HEAD`, since that member would ship as Done with the PR, and prints the fix: remove it from `group:` and move it back to To Do with `werkmeister issue update <KEY> --status "To Do" --comment …`.

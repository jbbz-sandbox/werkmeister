---
"werkmeister": patch
---

SW-807: the two `with-temp-home env WERKMEISTER_ROOT=* node --test` ask rules are written as `… node --test*`. With the old `:*` suffix Claude Code read the other `*` literally, warned at every workspace session start, and never asked. Run `werkmeister machine migrate` (or `workspace init`) to rewrite open workspaces.

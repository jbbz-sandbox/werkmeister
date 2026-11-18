---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace --gate` takes `--pr-line '<key>: <value>'` (repeatable), written into the seeded PR file as is, so a test can seed an unquoted value that `--pr-field` would quote, e.g. `--pr-line 'skip_release: no changeset: test-only'`, which the gate refuses with "Quote values that contain a colon". The keys are `--pr-field`'s but `status` (`--pr-field status=` already writes that line as is); one line, and it needs `--gate` (exit 2 otherwise). In-process fixtures take `prLines` (SW-851). Rerun `werkmeister workspace init` to regenerate the script's usage line.

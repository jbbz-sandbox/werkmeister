---
"werkmeister": patch
---

An interactive workspace now pre-approves the same `git commit` forms as an autonomous one (`-m`, `-qm`, `-q -m`, `--amend -m`, `--fixup`, exact `--amend --no-edit`), bare and `-C <own repo>`, and denies `--pathspec-from-file`. Before, it had only read-only git, so each stage's commit rested on auto mode's classifier, which could refuse it mid-stage. `werkmeister machine migrate` or `werkmeister workspace init` brings an existing workspace's rules up to date (SW-912).

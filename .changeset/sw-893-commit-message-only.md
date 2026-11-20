---
"werkmeister": patch
---

An autonomous workspace's `git commit` rule now takes the message on the command line only: `git commit -m`, `-qm`, `-q -m`, `--amend -m`, `--fixup` and exact `--amend --no-edit`, bare or `-C <own repo>`. `git commit -F <file>` asks, since it read any host file into a commit that the pre-approved `pr open` pushes, and `--pathspec-from-file` is denied, since its error prints the file's lines (SW-893).

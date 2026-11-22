---
"werkmeister": patch
"werkmeister-core": patch
---

PR rules rule 3 (SW-982): a background gate or `pr open` job takes no trailing `echo "exit $?"` (its 0 replaces the command's exit code in the completion notice), and `pr open` runs only after a `pr gate` log shows `<repo>: gate passed` for every repo.

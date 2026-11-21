---
"werkmeister-core": patch
"werkmeister": patch
---

A grouped PR's fix and implement contracts now say to commit each ticket as soon as its change, test and release entry pass, fold a later fix into its ticket with `--fixup`, and never split a mixed diff afterwards by hunk (`git apply --cached`, `git add -p`); an unavoidable split stages whole-file versions per commit (SW-904).

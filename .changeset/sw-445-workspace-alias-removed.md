---
"werkmeister": minor
---

SW-445: `werkmeister workspace <word>` (and `ws <word>`) with a word that is not a subcommand now fails with `unknown command` and creates nothing. The deprecated `workspace <feature>` form, due for removal in 0.58.0, is gone: use `workspace new <feature>`.

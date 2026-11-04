---
"werkmeister-core": patch
---

`werkmeister pr status` says why a merged PR in a `ship: tag` repo is not shipped yet: `not shipped yet: no release tag contains <sha>; latest tag <tag> (<date>) predates the merge (<date>)`, or `no tag matches <pattern> yet` when the repo has none. With `skip_release` set it also names the `release: none` fix (SW-389).

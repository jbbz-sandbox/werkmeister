---
"werkmeister-core": patch
"werkmeister": patch
---

SW-219: for a repo whose registry entry has a gate `lint` command, the generated `werkmeister-context.md` How to validate test commands end with `&& <lint>`, so the implement stage that runs them catches a format error before `werkmeister pr open`. Repos without `lint` render unchanged; the PR gate's own lint row is unchanged.

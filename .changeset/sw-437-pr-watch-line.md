---
"werkmeister": patch
---

SW-437: every `pr open` run that opens a PR prints one `pr watch:` line: scheduled (where, and its log), or NOT scheduled with `werkmeister pr watch --install`, so a session knows whether a failing check or a conflict will wake it.

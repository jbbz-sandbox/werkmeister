---
"werkmeister-core": patch
"werkmeister": patch
---

Autonomous workspaces now pre-approve `werkmeister feature stop` and `werkmeister feature stop <own feature>` (and the legacy `stop` spellings), exact, so the implement stage's stop and the run limits' stop after `pr open` no longer prompt. `stop infra` and another feature's name still ask. As any stop does, it frees the feature's capacity, so a waiting workspace may start. A bare `feature stop` now refuses `FEATURE=infra` read from a `.env`; `werkmeister infra stop` stops shared infra (SW-1215).

---
"werkmeister-core": minor
---

A spike workspace can now open a PR for a deliverable in a code repo, such as a write-up in `docs/research/` (SW-83). A template with no propose stage keeps its PR files in its last stage's `output/` (`stages/02_findings/output/pr-<repo>.md`), so `werkmeister pr gate`, `pr open`, `pr adopt` and close-out work for a spike the same as for any workspace. Spikes now get `_shared/pr-rules.md`, and the findings stage says when to write a PR file. A spike with no PR file closes out as before. A PR file can set `skip_exercise: <reason>` to skip the gate's exercise check when there is nothing to run. With no PR file, `pr gate` / `pr open` say which file to write, where the format is, and that the person approves it. The PR guard now denies only a real `gh pr create` at the start of a statement; the phrase inside quotes, a heredoc body or a grep pattern no longer trips it.

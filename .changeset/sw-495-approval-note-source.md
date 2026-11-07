---
"werkmeister-core": patch
---

SW-495: the approval notes (`(approved in chat YYYY-MM-DD)`, `(approved via check-in YYYY-MM-DD)` and their PR-file YAML-comment forms) now come from one export, `APPROVAL_NOTE` in `pr_rules.ts`, which builds the generated approval text. A new test fails when the `w9r-pr` skill, `docs/workspace-lifecycle.md` or the plugin's `check-in` skill spells a note any other way. The generated text is unchanged.

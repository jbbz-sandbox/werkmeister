---
"werkmeister": patch
---

`with-fixture-workspace --workflow <dir>` seeds an ICM workflow folder (`workflow.yaml` and `stages/*.md`) at the fixture's temp HOME `.werkmeister/workflows/<folder name>/`, or with `--workflow-in repo` in its code repo, and makes the fixture an icm workspace of that type. `--then-append <path> <text>` edits a seeded workflow file (`workflow:<path>`) or a fixture `.md` between steps, so `workspace init --then-append workflow:stages/<name>.md "…" --then skills check` shows a template edited after init in one call (SW-1108).

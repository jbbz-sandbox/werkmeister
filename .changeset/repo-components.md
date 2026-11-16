---
"werkmeister": patch
---

A repo's `.werkmeister/services.yaml` can list the project's tracker components under `repo.components` (name → what it covers). The fragment schema accepts the key and `registry sync` copies it to `repos.<repo>.components`; no command reads it yet.

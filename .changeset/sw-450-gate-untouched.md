---
"werkmeister-core": patch
"werkmeister": patch
---

SW-450: the pre-PR gate names the services a diff left untested (`tests: not touched, not run: …`), and a repo fragment's `repo:` block takes `path_mappings` for paths no service owns, so the werkmeister repo no longer tests all five services for a change under `apps/werkmeister-mcp`, `plugins`, `.github`, `.vscode` or `.claude`.

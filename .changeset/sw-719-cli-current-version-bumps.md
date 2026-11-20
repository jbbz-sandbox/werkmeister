---
"werkmeister": patch
---

`werkmeister issue start` reads a linked checkout as current when the only commits it lacks from `origin/main` are changesets "version packages" commits (CHANGELOG.md files, deleted `.changeset/*.md`, and `"version"` lines in package.json). A run no longer stops to rebuild a CLI whose code is the same. Any other missing commit still reads stale (SW-719).

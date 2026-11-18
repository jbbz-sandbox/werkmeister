---
"werkmeister": patch
"werkmeister-core": patch
---

Two repos in one workspace that use the same `node_modules_volume` name now get `<repo>-<name>` volumes instead of sharing one; a workspace with one such repo keeps its volume. `clean` recognises the scoped names.

---
"werkmeister-core": patch
---

The core, CLI and MCP test entries refuse to start when HOME holds the real `~/.werkmeister` and is not `with-temp-home`'s temp HOME, which every version of the wrapper marks by setting TMPDIR to it (SW-662).

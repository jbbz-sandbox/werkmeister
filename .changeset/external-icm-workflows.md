---
"werkmeister": minor
---

ICM workflows load from `<repo>/.werkmeister/workflows/<type>/` and `~/.werkmeister/workflows/<type>/` before the built-ins, and the create form, wizard and MCP create path accept those work types. An invalid workflow fails init with an `[err]` line before any file is written. See "Adding your own workflow" in `docs/icm-workflows.md`.

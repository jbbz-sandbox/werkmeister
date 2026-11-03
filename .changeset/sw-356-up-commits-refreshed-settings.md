---
"werkmeister-core": patch
"werkmeister": patch
---

`werkmeister feature up` commits the `.claude/settings.json` and `.werkmeister/claude-permissions.json` it rewrites on the record branch (`chore: refresh Claude settings`), the way `workspace create` commits them, instead of leaving them uncommitted when a werkmeister upgrade added a permission rule since the workspace was inited.

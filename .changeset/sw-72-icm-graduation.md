---
"werkmeister": minor
"werkmeister-mcp": minor
---

Graduation works in icm workspaces (SW-72). Each context strategy now supplies its own decisions. In icm they are the `status: decided` sections of `stages/*/output/*.md`, one per heading, with id `stages/<stage>/output/<file>.md#<heading-slug>`. `werkmeister notes graduate`, the `werkmeister down` offer and the MCP `notes` `graduate` action scaffold them through the same `graduateNote` path jit uses. Their `graduating → graduated` state is kept in `.werkmeister/graduations.yml`, so the stage outputs are never rewritten. MCP `notes` `list` also returns the open `decisions`. jit is unchanged. The not-in-workspace error no longer names the old `.sandbox/` directory.

---
"werkmeister": patch
"werkmeister-core": patch
"werkmeister-mcp": patch
---

SW-551: when `workspace init` (or `workspace new`) can't get a feature slot, it no longer reports plain success. It warns that the container step did not run and gives the next step: free a slot with `werkmeister feature down <feature>`, then rerun `werkmeister workspace init`. It also writes that notice to `.werkmeister/werkmeister-context.md`, so the agent sees it there too, and the next successful init replaces it with the container recipe. The MCP `init-workspace` tool result now includes `containers`.

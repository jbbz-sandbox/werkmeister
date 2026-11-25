---
"werkmeister": minor
---

A `repo.components` entry in `.werkmeister/services.yaml` can be `{ description, paths }` as well as a plain description: `paths` are repo-relative prefixes whose files belong to that component. The triage skill now lists the code each new ticket names (`report.py`'s "Code named in new tickets" section). It maps those files to a component through `paths`, and, when a code-graph MCP is connected, it uses the MCP to find same-code tickets, overlap with running workspaces and linked tests (SW-1209).

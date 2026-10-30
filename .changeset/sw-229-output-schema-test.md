---
"werkmeister": patch
---

SW-229: `list-workspaces` results no longer fail an MCP client's output-schema check (its schema was missing `model`). Every MCP tool with an `outputSchema` now declares `readOnlyHint`, and a test validates each read-only tool's result against its schema the way a client does after `tools/list`.

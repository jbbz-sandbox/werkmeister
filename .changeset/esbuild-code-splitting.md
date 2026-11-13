---
"werkmeister": patch
---

The npm package is smaller: the CLI, the MCP server and the dashboard now share one copy of their common code instead of each carrying its own. The install's `dist/` drops from about 12 MB to about 7 MB and the download from 4.4 MB to 2.3 MB. Nothing changes in how any command runs.

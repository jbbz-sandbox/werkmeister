---
"werkmeister": patch
---

Workspace cards no longer read Done when a Claude Desktop run is waiting on you. The agent-state hook now records a `wrap_up` box's question as needs-you, even when the closing message after it asks nothing.

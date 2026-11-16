---
"werkmeister": patch
---

SW-835: `werkmeister feature up --service <name>` refreshes the workspace's Claude settings first, as the whole `feature up` already does. A workspace whose `.claude/settings.json` lost rules werkmeister recorded in `.werkmeister/claude-permissions.json` (for example an `ask` block deleted by hand) gets them back on its next `up --service`, and the repaired files are committed on the record branch. It refreshes only the workspace the command runs from, and never inside the feature's own container.

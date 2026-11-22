---
"werkmeister-vscode": patch
---

The host line reads `host 122% · features 3.6 of 12 cores` in the VS Code view and the /workspaces pane (SW-1008): host is the 1-minute load as a share of the cores, features is the feature containers' CPU in cores. The 5 and 15 minute load moved to the tooltip. Both views now take it from one shared status-strip model, which also builds the strip's chips.

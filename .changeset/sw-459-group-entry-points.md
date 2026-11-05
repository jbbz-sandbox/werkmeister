---
"werkmeister": minor
---

A grouped PR (SW-438) no longer needs a hand edit of `workspace.yml`: `werkmeister workspace new` and `werkmeister workspace init` take `--group <member keys>`, the create form (terminal wizard, browser form, Desktop pane and its `workspaces_pane_fill_create_form` tool) has a **Grouped PR members** field, the `init-workspace` MCP tool takes `group`, and the plugin's next-wave skill folds a triage group into its lead and creates the lead's workspace with `--group`. `WERKMEISTER_GROUP` still works (SW-459).

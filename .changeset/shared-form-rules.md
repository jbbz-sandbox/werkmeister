---
"@jbbz-sandbox/sandbox-cli": patch
---

The create form's rules live in sandbox-core (`validateFormData`, `repoSelectionError`, `mergeFormData`), shared by the browser form and the /workspaces pane. The pane now refuses Create without a service or repo instead of failing later in provisioning.

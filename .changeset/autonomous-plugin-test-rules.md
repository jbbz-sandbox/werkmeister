---
"@jbbz-sandbox/sandbox-cli": patch
---

An `autonomous` workspace's allow list now includes `claude plugin validate` and `claude plugin test`, so a headless run can check a plugin's pane tests itself. A blanket `claude plugin:*` rule is still not granted, since it would also allow installing and uninstalling plugins.

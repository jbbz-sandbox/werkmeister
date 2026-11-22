---
"werkmeister-vscode": patch
---

The Workspaces view title has a toggle to hide workspaces waiting on a release (SW-1003): cards whose PR merged and no release contains yet, and that need nothing from you. While it is on, Master control reads `N hidden · waiting on release`, and a click shows them again. The choice survives a window reload; a hidden workspace comes back by itself once its release ships or it needs you, and Master control's counts still include every workspace.

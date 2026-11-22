---
"werkmeister-vscode": patch
---

One-shot commands from the Workspaces view run as VS Code tasks, not pooled terminals (SW-979). `feature up/stop/restart/pause/resume` and `registry sync` share one task panel whatever their folder, stay out of sight while they work, and bring their output forward only when they fail. `feature down` and `machine detect`, which can stop and ask, come forward with focus. The view refreshes as soon as a command ends. The New Workspace wizard, Connect infra (which can hand the terminal to `gh` to sign in), logs and session terminals are unchanged.

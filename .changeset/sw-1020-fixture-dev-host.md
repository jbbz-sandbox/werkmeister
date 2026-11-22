---
"werkmeister-vscode": patch
---

Internal: `packages/werkmeister-vscode/scripts/manual-dev-host.mjs` opens an Extension Development Host over the snapshot fixture, with a temp HOME and VS Code dirs, a fake daemon and a logging stub CLI, so the manual check never acts on real workspaces. MANUAL-CHECKLIST.md and the validate text name it (SW-1020).

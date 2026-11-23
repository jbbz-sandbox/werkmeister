---
"werkmeister-core": minor
"werkmeister": minor
---

An ICM workspace built from a repo or `~/.werkmeister/workflows/` workflow records it in `.werkmeister/workflow.lock` (source folder, `version`, content hash). After that folder is edited, `werkmeister skills check` reports `template changed since init: <folder>` and names the folder, instead of saying the context layer lags the werkmeister repo; `werkmeister skills sync` updates the lock only when it re-renders. Workspaces built from a built-in workflow get no lock (SW-1078).

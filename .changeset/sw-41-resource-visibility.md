---
"werkmeister": minor
"werkmeister-core": minor
"werkmeister-vscode": minor
"werkmeister-ui": minor
---

Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.

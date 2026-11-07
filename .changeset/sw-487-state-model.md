---
"werkmeister-core": minor
"werkmeister": minor
"werkmeister-ui": minor
"werkmeister-mcp": minor
---

SW-487: one workspace state model in werkmeister-core. `WorkspaceStatus.workspaceState` gives each workspace a phase, an activity (thinking, running a tool or tests, a background agent, queued for CPU, paused, containers starting, idle, session gone) and a needs-you list. Each item has what, since, action and source: questions, permissions, plans, stage gates, a dead session, run the postmortem, close it, crash loops and system notices, plus CI failed, conflict, changes requested and merge it from `getWorkspacePRs()`. Hooks now keep one record per session (`.werkmeister/sessions/<id>.json`), so sessions and subagents can't overwrite each other's ask, and a crashed session reads as gone after 30 minutes. The /workspaces pane lists every item with its time and action, and check-in reads the same model. Run `werkmeister machine migrate` to add the new Claude Code hook events to existing workspaces.

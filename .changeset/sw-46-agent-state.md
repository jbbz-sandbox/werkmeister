---
"werkmeister": minor
"werkmeister-core": minor
---

Agent state tells Done, Needs you and Working apart (SW-46). Every workspace now gets a `werkmeister hooks agent-state` hook on UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and SessionEnd. The hook records `{state, at, question?}` in `.werkmeister/agent-state.json`. `getWorkspaceStatuses()` returns `claude.agent` (`working` · `needs-you` · `done` · `idle`), `claude.at` and `claude.question` in place of `claude.waiting`, and falls back to the transcript tail when a workspace has no state file yet. Existing workspaces pick up the hooks on their next `werkmeister up`. The workspaces pane and the dashboard show `◌ Working`, `● Needs you` and `✓ Done`, so a finished run no longer reads "waiting for you".

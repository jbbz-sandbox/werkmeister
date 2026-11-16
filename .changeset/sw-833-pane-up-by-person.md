---
"werkmeister-core": patch
---

SW-833: `runWorkspaceAction` takes an optional `{ byPerson }` that says a person, not an agent, asked for an `up`. The workspaces pane's Up passes `byPerson: true`, so a person's Up on a full machine can stop agents' features instead of queueing behind them, in a workspace that is not autonomous. An autonomous workspace's Up still queues as an agent's. Before this, the pane ran inside Claude Code and inherited `CLAUDECODE=1`, so its Up always counted as an agent's start.

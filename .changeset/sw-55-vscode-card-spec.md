---
"werkmeister-vscode": minor
---

SW-55: the VS Code Workspaces tree follows the unified card spec. Each workspace's description spells out the agent state, containers, stage and issue (`● Needs you · 2 of 2 up · stage 2/4 · #143`), and its icon follows the agent. The tooltip shows the full Containers / PRs / Workflow / Agent rows, with `⚙ Autonomous` and the agent's question. Colours use board 09's tone map, and PRs appear as child rows. New actions: `↗ Continue in Terminal`, `＋ New session`, `↻ Refresh PRs`, `Open PR ↗`, `⚡ Connect infra` and a `?` legend. "Close Out Workspace..." is split into `✓ Close out` and `✕ Abandon…`.

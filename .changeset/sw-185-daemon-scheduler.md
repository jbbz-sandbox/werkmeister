---
"werkmeister-core": minor
"werkmeister": minor
"werkmeister-mcp": minor
---

The host daemon now owns the scheduler (SW-185): slot leases, the waiting queue, and starting waiters.

- **Through the daemon:** the CLI, the stdio MCP server and the dashboard ask the daemon (`POST /api/tool`, machine token) to allocate, read and release slot leases, admit or queue a feature (including preemption), and read the waiting queue. VS Code reaches it through the CLI and the `status` tool. Agents can't call these ops: they aren't on `/mcp`.
- **Starting waiters:** after a client's `stop` or `down`, the daemon starts the next waiting feature in the background. The CLI prints `The daemon will start the next waiting feature (N waiting)` and no longer starts the waiter's containers itself. The `pr watch` tick still starts waiters.
- **Fallback:** with no daemon (or no daemon token, as in CI and tests), a client warns once and schedules in its own process against the same `~/.werkmeister/scheduler/` files and locks. The daemon reads those same files, so existing leases and waiters carry over on upgrade with nothing to migrate.
- **Fix:** `/api/tool` waits up to 15 minutes for a tool instead of the MCP SDK's 60 s, so a long close-out or grant isn't cut off.

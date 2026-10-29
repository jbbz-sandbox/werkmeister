---
"werkmeister-core": minor
---

SW-182: idle-stop and the Resume nudge read a session liveness record the agent-state hook writes to `.werkmeister/agent-state.json` (`sessions`, keyed by session id), not Claude Code's session files. The hook now also runs on SessionStart; a workspace picks that up at its next `up`.

---
"werkmeister": patch
---

SW-570: a stage gate at `status: proposed` (a PR file at `status: draft`) is a Needs you item only once the agent has handed it over. While the session is busy, has a background shell running (`Running tests`, or `Running a background shell`), waits on capacity (`Waiting for capacity · position N` once its turn ends) or has containers starting, the /workspaces card, the VS Code tree and check-in show that activity and no Needs you dot. In an autonomous workspace a draft gate never needs the person. A background shell counts until the session's next turn ends, or for 30 minutes.

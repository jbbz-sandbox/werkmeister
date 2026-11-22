---
"werkmeister": patch
"werkmeister-core": patch
"werkmeister-vscode": patch
---

The workspace card shows one state word (SW-953). The agent chip reads Working whenever the session itself works (tests, a tool, a background agent, thinking), not only after a finished turn, so it no longer says Idle beside "Thinking" or "Background agent running". The activity line is the chip's detail: it is left out when it only restates the chip (no "Done" beside "Idle"), Thinking's time is when the session was last heard from rather than when its turn began, and a Thinking silent for 30 min or more reads dim as "Thinking · last heard 40 min ago". Same in the VS Code view, the /workspaces pane and the dashboard.

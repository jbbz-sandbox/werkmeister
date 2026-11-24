---
"werkmeister": patch
---

SW-1111: `werkmeister feature logs` follows the logs only onto a terminal. Without one (a pipe, a script, an agent's Bash call) it prints the last 100 lines of each container and returns, so the command a failed start's message names no longer hangs an agent's tool call.

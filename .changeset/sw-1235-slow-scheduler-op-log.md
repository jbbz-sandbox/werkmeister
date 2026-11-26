---
"werkmeister": patch
"werkmeister-mcp": patch
---

SW-1235: the daemon logs a scheduler op (lease, allocate, admit, grant, ...) still running after 30 s, with when it started and its op and feature, and again when it ends with how long it took, so a client's 120 s `did not answer in time` can be traced in `~/.werkmeister/sandbox-mcp.log`.

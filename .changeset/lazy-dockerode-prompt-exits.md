---
"werkmeister": patch
"werkmeister-core": patch
"werkmeister-mcp": patch
---

Faster starts and prompt exits. `dockerode` (about 300 modules, ~0.2 s of CPU) loads on the first Docker call instead of at start, so a command that never reaches the Engine no longer pays for it. A command that is not installed (a missing `gh`, say) no longer holds the process open for its whole timeout after failing. The MCP proxy exits when its client closes stdin, instead of waiting two seconds to be signalled.

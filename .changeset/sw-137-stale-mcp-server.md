---
"werkmeister-core": patch
---

`werkmeister connect` replaces a host web server that holds its port but can no longer serve (SW-137). An example is an MCP server left running from a deleted worktree that answers 400 to every request. `start()` and `status()` now check the server over HTTP with a JSON POST, instead of trusting a live PID or an open port. The `web-servers-self` test runs on an ephemeral port and kills anything it spawned, so it can no longer start a detached server on the real port 3002.

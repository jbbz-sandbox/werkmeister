---
"werkmeister-core": patch
"werkmeister": patch
---

SW-183: lock waits no longer block the event loop. `sandboxLock` now awaits a timer between retries instead of `Atomics.wait` and always returns a promise, so two concurrent `up` calls through the HTTP MCP server both finish instead of hanging the server (the Caddyfile lock had no timeout) or failing after 30 s (the slot lock).

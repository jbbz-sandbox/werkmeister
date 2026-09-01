---
"@jbbz-sandbox/sandbox-cli": patch
---

Route the last ten direct `console.*` writes in `sandbox-core` (`compose`, `browser`, `safari`) through the reporter, so a library import can no longer corrupt `sandbox mcp --stdio`'s JSON-RPC stream. CLI output is unchanged, byte for byte.

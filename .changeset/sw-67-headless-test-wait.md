---
---

Test-only: the `deliverHeadless` SW-16 test now waits for the fake `claude` to log its resume call instead of assuming it finished within `sendToClaudeSession`'s 2.5 s grace, which macOS's first-exec check on a fresh stub outlasts under the full core suite (SW-67). Nothing ships.

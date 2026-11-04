---
"werkmeister": patch
---

The ICM test step shows the log redirect wrapping the whole `&&` test chain (`{ <test command>; } > <log> 2>&1; echo "exit $?"`), so the turbo output no longer spills into the tool result (SW-334).

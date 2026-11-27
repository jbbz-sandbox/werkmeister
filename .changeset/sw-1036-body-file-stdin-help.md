---
"werkmeister": patch
---

SW-1036: `werkmeister issue create --help` and the CLI reference now say `--body-file -` (stdin) is not taken in an autonomous workspace, and the refusal says to write the body to a file in the workspace. Stdin stays refused there on purpose (SW-815).

---
"werkmeister": patch
"werkmeister-core": patch
---

PR rules (SW-661): rule 3's background-job recipe now covers `pr gate` and `pr gate --tests` too (`werkmeister pr gate --tests > <workspace>/.werkmeister/gate-run.log 2>&1`, kept on the record branch with the other `gate-*.log`), and the ICM stage contracts and `pr` help point to it instead of saying "detached", so a full gate no longer gets cut off by a 10-minute foreground tool call.

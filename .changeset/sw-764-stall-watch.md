---
"werkmeister-core": patch
---

ICM contracts: the review subagent runs in the foreground when nothing else is pending; a background review, test or gate job quiet for 10 minutes is stopped and relaunched once, then the person is told (SW-764).

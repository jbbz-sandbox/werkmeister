---
"werkmeister": patch
---

SW-1196: the telepresence runners `_run` and `runAsyncRunner` share one error mapping (a missing binary is 127, a timeout is 124, anything else, an abort included, is rethrown), and tests now cover both runners. Behaviour is unchanged.

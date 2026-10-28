---
"werkmeister-core": patch
---

SW-148: `runCapture("gh", …)` resolves the binary through `WERKMEISTER_GH_BIN`, so `withFakeGh` fakes every core `gh` call and a test can no longer reach the real `gh` past `childEnv()`'s PATH. The fake now covers `api user` and `search prs` and fails closed on any other subcommand.

---
"werkmeister": patch
---

`with-temp-home` exports `WERKMEISTER_TEMP_HOME`, set to the temp HOME itself. The probe guidance in the ICM stage contracts and in `werkmeister-context.md` § How to validate now says that a probe that writes under `~/.werkmeister` or runs the CLI starts with a load-time guard (`if (process.env.WERKMEISTER_TEMP_HOME !== process.env.HOME) throw …`), never a `test()` check, which node:test would outlive (SW-1049).

---
"werkmeister": patch
---

The generated `with-temp-home` records why it keeps the caller's corepack cache (`COREPACK_HOME`): a `shortcut:` line names the limit, pnpm downloads written outside the temp HOME, and how to lift it (SW-917).

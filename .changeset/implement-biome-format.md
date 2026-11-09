---
"werkmeister": patch
---

The implement-side stage contracts (02_fix, 03_implement, refactor 02_implement) now tell the agent, in a repo that uses biome, to run `pnpm exec biome check --write <the files you touched>` before the tests and the commit, so formatting lands in the ticket's own commit (SW-547).

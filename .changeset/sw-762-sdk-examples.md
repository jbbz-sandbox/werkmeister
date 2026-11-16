---
"werkmeister-core": patch
---

SW-762: every page of the SDK reference now has SDK-user docs and a type-checked example: the 127 exports SDK parity added (functions, interfaces, type aliases and `WORKSPACE_ACTIONS`) are rewritten for SDK users (what each does, returns and throws, in-process or daemon) with a `werkmeister-core/sdk` example. Several docs now match their code where they did not: `parseNote` returns the note with empty frontmatter on a bad header, `fetchIssueCard` returns `{ ref, url }` on a failed fetch, `infraDown`/`infraStop`/`infraRestart` log a failure instead of throwing, and `InfraStatus` reports unhealthy services separately.

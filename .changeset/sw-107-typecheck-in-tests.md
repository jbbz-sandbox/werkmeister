---
"werkmeister-core": patch
---

SW-107: fragment detection puts a package's `typecheck` script before `test` in its detected test command (for pnpm, `pnpm --filter api run typecheck && pnpm --filter api test`), so a workspace's listed test commands fail on a TypeScript error the way CI does. This repo's own `cli`, `werkmeister-core` and `werkmeister-vscode` test commands now run `typecheck` too.

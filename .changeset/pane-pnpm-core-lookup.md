---
"werkmeister": patch
---

The Workspaces pane finds `werkmeister-core` when the CLI is installed with `pnpm link --global`. pnpm's global bin is a shell shim outside the package, so the pane failed with `Cannot find module 'sandbox-core'`; it now also looks under pnpm's global folder, and the error names `WERKMEISTER_CORE_PATH` when neither works.

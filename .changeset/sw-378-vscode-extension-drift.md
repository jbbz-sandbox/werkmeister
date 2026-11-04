---
"werkmeister-vscode": patch
---

SW-378: from a checkout, `werkmeister machine setup --check` reports a Werkmeister Workspaces extension whose installed version differs from `packages/werkmeister-vscode`. `pnpm --filter werkmeister-vscode install:local` builds, packages and installs the checkout's extension in one command, and the plugin's install check reports drift when the extension's source is newer than the installed copy. Setup still never installs a checkout build on its own.

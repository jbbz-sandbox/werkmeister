---
"werkmeister-core": patch
---

An npm-installed werkmeister-core finds the CLI package without `WERKMEISTER_ROOT`. When no werkmeister checkout sits above core, `sandboxRoot()` (and with it `infraRoot()` and every function that starts or creates things, such as `up` and `createWorkspace`) and the CLI-wrapper lookup follow the `werkmeister` on PATH to its package, e.g. `$(npm root -g)/werkmeister`. A `werkmeister` on PATH whose nearest `package.json` is not named `werkmeister` is skipped. `WERKMEISTER_ROOT` still overrides, and a checkout still wins over the global install.

The lookup follows symlinked bins (npm global installs, `npm link`), not pnpm's shell-script shims; set `WERKMEISTER_ROOT` there. Anything that resolves the CLI wrapper through core without `WERKMEISTER_ROOT`, such as the VS Code extension and the dashboard, now also falls back to the `werkmeister` on PATH before `~/.local/bin/werkmeister`, where it used to stop with an error.

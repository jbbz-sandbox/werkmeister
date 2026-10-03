---
"@jbbz-sandbox/sandbox-cli": minor
---

The Sandbox Workspaces VS Code extension ships in the CLI package as `dist/sandbox-workspaces.vsix`, and `sandbox setup` offers to install it (section 8, now "VS Code"). It is versioned with the CLI, so a re-run upgrades a stale install and `--check` reports one. Only the packaged `.vsix` is ever installed — a checkout has none, since `prepack` builds it, not `build`.

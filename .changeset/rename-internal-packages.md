---
"werkmeister": patch
---

Renamed the internal workspace packages to match the CLI (SW-6): `sandbox-core` is now `werkmeister-core`, `sandbox-mcp` is `werkmeister-mcp`, `sandbox-workspace-mcp-app` is `werkmeister-dashboard`, the root `sandbox` is `werkmeister-monorepo`, and `vscode-plugin` is `werkmeister-vscode`. None is published, and the CLI bundles the core library, so the CLI's behaviour is unchanged. Directories, registry service names and container names keep their old names.

The VS Code extension id follows its package name: `jbbz.vscode-plugin` is now `jbbz.werkmeister-vscode`. `sandbox setup` looks for the new id, so a machine with the old extension installed gets the new one installed beside it. Uninstall `jbbz.vscode-plugin` by hand.

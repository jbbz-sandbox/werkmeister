---
"werkmeister": minor
---

SW-106: the old "sandbox" name is gone. **Run `werkmeister migrate` once after upgrading.**

Breaking:
- The `sandbox` command is removed. Use `werkmeister` or `w9r`. Shell completion now covers both, in a `# >>> werkmeister completion >>>` block.
- `~/.sandbox` and a workspace's `.sandbox/` are no longer read, and neither is a repo's `.sandbox/services.yaml` fragment. `werkmeister migrate` moves `~/.sandbox`, and `werkmeister migrate --workspaces` renames workspace dot-dirs. The CLI says so when it finds `~/.sandbox` without `~/.werkmeister`.
- `SANDBOX_*` environment variables are no longer read, and every exported name is now `WERKMEISTER_*` (`env.sh`, compose, container env, `WERKMEISTER_SLOT`, `WERKMEISTER_MCP_TOKEN`, …). `migrate` regenerates `env.sh` and swaps the `~/.zshenv` block.
- Config keys: `paths.sandbox_root` is now `paths.werkmeister_root`, and `overrides.sandbox_issues_project` is now `overrides.werkmeister_issues_project`. The `${SANDBOX_ROOT}` volume placeholder is now `${WERKMEISTER_ROOT}`. `migrate` rewrites `config.yaml`, `services.yaml` and `services.local.yaml`.
- The `/__sandbox` selector alias is removed. Use `/__werkmeister`.
- The legacy `sandbox-shared` network is removed (services stay on `werkmeister-shared`), the Jaeger container is now `w9r-jaeger`, and the tools dir is `/opt/werkmeister-tools`. Recreate the shared infra once (`werkmeister down infra`, then `werkmeister connect`).
- Workspace skills are now `w9r-*` (were `sb-*`), and the generated context file is `.werkmeister/werkmeister-context.md`. The next `init-workspace` removes the old copies.

Transition: workspaces now send `X-Werkmeister-Feature` and export `WERKMEISTER_FEATURE`. `X-Sandbox-Feature` and `SANDBOX_FEATURE` are still read, and still exported, until every workspace has re-run `init-workspace` and Playwright suites read the new name.

Also renamed: CLI help, banners and errors, MCP tool descriptions, skills, generated `CLAUDE.md` and stage contracts, the feature selector page, the VS Code extension's titles and category, and the docs. The VS Code command, view and setting IDs keep their `sandbox.*` names, so keybindings keep working. A new `pnpm run name:check` fails CI on any new "sandbox" outside the kept names.

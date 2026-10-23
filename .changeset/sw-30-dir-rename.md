---
"werkmeister": minor
---

Breaking for workspaces of the werkmeister repo itself (SW-30). Its directories now match their package names (`apps/werkmeister-mcp`, `apps/werkmeister-dashboard`, `packages/werkmeister-core`, `packages/werkmeister-ui`, `packages/werkmeister-vscode`), and the services in its registry fragment follow. `sandbox-core` is now `werkmeister-core`, `sandbox-dashboard` is `werkmeister-dashboard`, and `vscode-plugin` is `werkmeister-vscode`, so containers are named `<feature>-werkmeister-core` and so on. `cli` and `apps/cli` are unchanged, so the global link and `sandbox_root` still work. There is no alias for the old ids. To migrate a workspace:

- Run `werkmeister down <feature>` before you pull this release. If you've already pulled it, remove the leftover `<feature>-sandbox-core`, `-sandbox-dashboard` and `-vscode-plugin` containers with `docker rm -f`.
- Run `werkmeister registry sync` from the updated main checkout. Then rename those three keys in `services.local.yaml` (in `~/.werkmeister/`, or `~/.sandbox/` on older machines) and in any `services:` list or `--services` value that names them.
- The dashboard's host is now `werkmeister-dashboard.local.sandbox.com`. Run `werkmeister setup` from the main checkout to add it to `/etc/hosts`.
- In a checkout, run `pnpm install` after pulling, so the workspace links follow the moved directories.

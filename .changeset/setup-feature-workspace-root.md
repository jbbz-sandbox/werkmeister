---
"@jbbz-sandbox/sandbox-cli": patch
---

sandbox-feature-test: `setup_feature.py` resolves the workspace through `paths.workspaces_root` like `resolveWorkspace` does, so running it from a workspace root (itself a git repo) no longer scaffolds `playwright.config.ts` and the spec into the workspaces root (#107).

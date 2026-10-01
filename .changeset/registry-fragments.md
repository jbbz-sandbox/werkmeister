---
"@jbbz-sandbox/sandbox-cli": minor
---

`~/.sandbox/services.yaml` is now generated from each repo's `.sandbox/services.yaml` fragment. `sandbox setup` scans `paths.repos_root` after cloning, merges the fragments under the sandbox's archetype/MCP defaults and over a new per-machine `~/.sandbox/services.local.yaml` (which now holds `k8s_context` and any hand edits), and writes the registry. New `sandbox registry sync` / `sandbox registry --check` run that step alone. A pre-existing hand-written registry is backed up to `services.yaml.bak-<ts>` on the first run; move its entries into the owning repos' fragments. The demo and empty registry seeds are gone: with no fragments found, setup says so instead of writing a skeleton.

---
"@jbbz-sandbox/sandbox-cli": minor
---

Validation guidance for services without a URL. `services.yaml` gains a `validate:` field (a service's own value beats its archetype's; defaults ship for `node-tool` and `mcp-client`), and `sandbox-context.md` opens with a How to validate table per service, rendering routing, Caddy and cookie sections only when a URL-addressed service needs them. `sandbox test` looks for a Playwright config in the workspace root, then each repo worktree; with no suite it runs nothing and prints each service's test command and validation instead. Fragments accept `type: extension`.

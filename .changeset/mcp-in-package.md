---
"@jbbz-sandbox/sandbox-cli": minor
---

The headless MCP server (`apps/mcp`) is bundled into the CLI package as `dist/mcp.js`, so `sandbox mcp` and the MCP server `sandbox connect` starts on 3002 work from an `npm install -g` with no checkout. `sandbox dashboard` falls back to that bundle when the workspaces dashboard app is absent, which keeps the `sandbox-tools` plugin's MCP entry serving the `sandbox-*` verbs on a package install; the dashboard itself (Jira, PRs, MCP-App UI) stays checkout-only. `sandbox connect` no longer prints a dashboard URL it did not start. Sourcemaps are dropped from the tarball. The sandbox-diagnose and sandbox-caddy-reload skills no longer import `dist/lib/caddy.js`, which the bundle never emitted.

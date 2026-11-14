---
"werkmeister": patch
---

The werkmeister repo's own workspaces get `apps/werkmeister-mcp/scripts/host-daemon.mjs`, named in the `werkmeister-core` validate text: it runs the branch's bundled daemon and CLI on the host, on a temp HOME and a free port (never 3002), with `node_modules` linked to the installed werkmeister's, so a daemon-auth or networking change can be called from a container via `host.docker.internal`.

The daemon on its loopback bind (`HOST` unset, `127.0.0.1`, `localhost` or `::1`) now accepts a container's `Host: host.docker.internal` header, so a call from a container reaches the token check (401 or 200) instead of the MCP SDK's 403. Browsers are still refused by the Origin check.

---
"werkmeister": patch
---

SW-1136: the dashboard's `dev` script rebuilds its real pages, `browser.html` and `form.html`, instead of watching the missing `mcp-app.html`. In a workspace container, an edit under `src/` reruns the full UI build by itself, with no manual `pnpm run build`. Vite's own `--watch` fails every rebuild after the first, so `node --watch-path` reruns `build:ui` instead.

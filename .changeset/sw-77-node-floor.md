---
"werkmeister": minor
---

Breaking for Node 20 and 21 (SW-77). The supported minimum is now Node 22: `engines` says `>=22` (Node 20 has been EOL since 2026-04), the bundles target `node22`, and a feature container with no `image:` defaults to `node:22` instead of `node:20.16.0`. Set `image:` in `services.yaml` to keep a different one. Upgrade the Node that runs the CLI to 22 or later (`brew upgrade node`, or `nvm install 22`).

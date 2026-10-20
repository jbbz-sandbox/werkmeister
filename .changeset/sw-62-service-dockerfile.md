---
"werkmeister": patch
---

A service in `services.yaml` can set `dockerfile:` to build its image from a Dockerfile in its `path` (tagged `image:`), instead of only pulling a prebuilt one. The sandbox repo's `vscode-plugin` service uses it to bake in xvfb and Electron's libraries, so `npm run test:integration` runs in a fresh container (SW-62).

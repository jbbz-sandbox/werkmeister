---
"werkmeister-vscode": patch
---

Stub dockerode's session-only `@grpc/*` requires in the extension bundle, so the esbuild watch build no longer fails (and crash-loops its container) when they are not installed; the bundle also shrinks by about 2 MB.

---
"werkmeister-core": patch
---

SW-66: `createWorkspace` and `initWorkspace` take `build: false` to skip the image build, so the core suite's create test no longer leaves a crash-looping `demo-backend` container and `demo` slot on the real Docker daemon.

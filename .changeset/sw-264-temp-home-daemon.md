---
"werkmeister-core": patch
"werkmeister": patch
---

SW-264: the generated `with-temp-home` exports `WERKMEISTER_HOST=http://127.0.0.1:1` unless the caller already set it, so a run under a temp HOME can no longer reach the real daemon on :3002; daemon calls raise `DaemonUnavailable` and take their local fallback. Existing workspaces pick it up with `werkmeister machine migrate`.

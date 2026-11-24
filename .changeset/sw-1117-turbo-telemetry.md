---
"werkmeister-core": patch
---

`with-temp-home` exports `TURBO_TELEMETRY_DISABLED=1`. Its fresh HOME made every `turbo` run a first run, so each test row and gate run could send Turborepo's telemetry (SW-1117). Existing workspaces pick the new wrapper up on `workspace init` or `machine migrate`.

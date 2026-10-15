---
"@jbbz-sandbox/sandbox-cli": patch
---

`sandbox up` no longer accepts `-s/--services` or `--force`. It never read them: `sandbox up -s <service>` exited 0 with nothing started and no warning. Both are now rejected as unknown options. To run a service locally, add it to `.sandbox/workspace.yml`, run `sandbox init-workspace`, then `sandbox up` (#153).

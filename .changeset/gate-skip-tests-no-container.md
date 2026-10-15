---
"@jbbz-sandbox/sandbox-cli": patch
---

`sandbox pr gate` accepts `skip_tests: { <service>: <reason> }` for a service that has a test command but no running container for its repo, so a workspace that runs no containers for the PR's repo can pass the test check. `sandbox pr status` no longer marks a `ship: tag` repo's PR `shipped` on merge because `skip_release` is set; it waits for a release tag containing the merge commit. (#145)

---
"werkmeister-core": patch
---

SW-120: the Open PRs tab searches the org from `overrides.github_org` (default: the workspace repo's owner) instead of the stale `sandbox` owner, and fails with a message naming that setting when no org is known rather than searching all of GitHub.

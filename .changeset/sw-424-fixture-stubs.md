---
"werkmeister": patch
---

Under `WERKMEISTER_FIXTURE` (`with-fixture-workspace`, core fixture tests) `claude` and `kubectl` are stubs that fail loudly, like `gh`, unless `CLAUDE_BIN` names a claude; and the caller's `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `KUBECONFIG` and `GH_TOKEN` are blanked for each fixture step (SW-424).

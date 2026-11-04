---
"werkmeister": patch
---

`with-temp-home` now unsets `CLAUDECODE` and every `CLAUDE_CODE_*` variable (keeping `CLAUDE_BIN`) before running its command, so a test or exercise run from an agent's shell matches a clean shell or CI. Run `werkmeister migrate` to refresh an existing workspace's wrapper (SW-332).

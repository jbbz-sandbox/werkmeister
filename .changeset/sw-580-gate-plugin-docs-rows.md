---
"werkmeister": patch
---

The install setup container puts Claude Code 2.1.316 (CI's pin) in the `tools` volume, so the plugin's `gen-types`, `claude plugin validate` and `claude plugin test` run in the cli and werkmeister-core containers.

---
"werkmeister": patch
---

Generated allow rules now cover the stage test commands run through `with-temp-home` (each `&&` segment, for every service of the workspace's repos) and the `env WERKMEISTER_ROOT=… node --test` fixture form, and werkmeister-context.md names those rules; headless sessions are no longer refused (SW-398).

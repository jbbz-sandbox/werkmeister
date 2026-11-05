---
"werkmeister": patch
---

Core tests run outside `with-temp-home` (a bare `node --test`, an editor's test runner) no longer write workspace tokens and locks into the real `~/.werkmeister`: `withSandboxHome` now points HOME at its temp home (SW-433). On a machine that ran them, delete the leftovers with `rm ~/.werkmeister/tokens/create-copy-ws-*`; no real workspace has that name.

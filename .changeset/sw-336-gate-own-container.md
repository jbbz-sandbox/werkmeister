---
"werkmeister-core": patch
"werkmeister": patch
---

SW-336: `werkmeister pr gate` (and `--tests`) runs each touched service's test in that service's own container, starting it on demand with its setup service, whatever its `type`. Before, a touched `web` service's test ran in whichever sibling container was running or started (e.g. an `api` service's), with the wrong image and `node_modules`. Lint and the release check still use any one container of the repo.

---
"werkmeister": patch
---

SW-1238: `werkmeister-context.md` now prints a repo's lint chain as its own `Lint:` command under the repo commands. The ICM fix and implement test steps run the tests the change reaches plus that `Lint:` command before `werkmeister pr gate --tests`, not the full test row, which the gate runs once.

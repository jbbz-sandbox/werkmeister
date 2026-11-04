---
"werkmeister": patch
---

ICM build stages (bugfix fix, feature and refactor implement) read `git diff` in each touched repo and tick off each settled edit before running the tests, so an edit that never reached the file is caught (SW-351).

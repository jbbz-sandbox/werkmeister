---
"werkmeister": patch
"werkmeister-core": patch
---

The ICM build stages (feature implement, bug-fix fix, refactor implement) start by fetching the base and listing the commits on it that touch the files `spec.md`, `repro.md` or `scope.md` changes, plus the status of any ticket a decided question names. A new commit or ticket change that bears on a decision stops the stage for the person before code is written.

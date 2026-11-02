---
"werkmeister-core": minor
"werkmeister": minor
---

A repo can carry its own standards in `<repo>/.werkmeister/standards/`, laid out like the global standards tree. A workspace that checks out the repo loads them on top of `overrides.standards_dir`, and they are active there without an archetype naming them (`standards_override.remove` still drops one). Their generated `w9r-*-standard` skills link to the repo they came from. `werkmeister standards check` also validates every repo tree under `paths.repos_root` and fails when a repo module reuses a global module's `domain`; the global one wins at load time. `checkStandards()` returns the repo trees it checked as `repoTrees`, and `loadStandardsModules` takes the workspace's repo paths as a second argument.

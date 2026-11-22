---
"werkmeister": patch
"werkmeister-core": patch
---

A doc-comment slip no longer stops `werkmeister feature up` for the werkmeister repo's own services (SW-1012). The `werkmeister-install` setup container used to build every package, and docs-site's typedoc treats a missing doc comment as an error, so the install exited 4 and no container started. It now builds every other package first, and that build still fails the install. Then it builds docs-site, and a failure there only prints a warning. The docs-site test row and the lint row's `docs:sdk` still fail on the slip. When a setup container does fail, the `Failed to start …` error from `feature up` (with or without `--service`) and the gate's service starts now ends with that container's name, its exit code and its last 20 log lines. Before, the cause showed only in `docker logs`.

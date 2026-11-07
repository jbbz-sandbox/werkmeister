---
"werkmeister": patch
---

SW-541: the pr gate's service starts no longer re-run `werkmeister-install` when it has already succeeded for the current lockfile and Node major. compose re-ran the exited install on every `up <svc>`, and after a source edit that rebuilt all seven packages at 2 CPUs before the gate's own tests built again. The gate now starts a service with `--no-deps` when every dependency is a setup service whose worktree stamp matches and whose container exited 0, and admission stops pricing that install. `feature up`, with or without `--service`, still re-runs the install, so a service started after a pull gets a fresh build. The shared turbo cache was not at fault: it restores 6 of 7 tasks on unchanged source; low counts came from edits between starts.

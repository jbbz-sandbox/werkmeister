---
"werkmeister": patch
---

Autonomous workspaces no longer pre-approve commands that reach past the workspace (SW-560). They lose `docker exec <feature>-<svc>:*`: every container can reach the host daemon, so a service keeps only its exact registered test in its container. The generic package-manager `run`, `test` and `turbo` rules are gone too, since each registered test and lint segment keeps its own rule. So are the `find`, `sed`, `mkdir`, `ls`, `cat`, `grep`, `head`, `tail`, `diff`, `wc` and `test` rules, which the Glob, Grep, Read and Write tools cover. The lockfile installs are now exact commands. `git -c`, `git config`, `--config`, `--exec-path`, `--template` and `--git-dir` are denied. The threat model in `docs/context-strategies.md` lists what stays open on purpose.

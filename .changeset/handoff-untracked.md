---
"werkmeister": patch
---

Close-out's handoff no longer commits untracked files (SW-91). It commits tracked changes only. Untracked files that `.gitignore` misses, such as a container's build cache, are saved to `handoff/<workspace>/<repo>.tgz` in the werkmeister home (`~/.werkmeister`, or `~/.sandbox` on an older machine) instead of being pushed. The close-out output shows each handoff commit's `--stat` and lists the files it kept. `close-out --abandon` no longer pushes a code branch that has no commits of its own; it saves the handoff commit as a `.patch` beside the tarball.

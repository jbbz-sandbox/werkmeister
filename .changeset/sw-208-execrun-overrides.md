---
"werkmeister-core": patch
---

SW-208: `pr open`, `pr status` and `pr gate` resolve `gh` through `WERKMEISTER_GH_BIN` and `docker` through the new `WERKMEISTER_DOCKER_BIN`, as do `runCapture` and `proc.run`/`runAsync`. A fixture run of the built CLI can therefore fake every gh and docker call. A fake first on PATH is not enough, because `childEnv()` puts `/opt/homebrew/bin` and `/usr/local/bin` ahead of it.

---
"werkmeister": patch
---

With `WERKMEISTER_CONFIG_FILE` pointing somewhere other than the default home, or with `WERKMEISTER_FIXTURE=1`, `werkmeister machine config --write` and `werkmeister machine setup` leave `~/.zshenv` and `~/.zshrc` alone and say so, and `--check` no longer reports `~/.zshenv` as drift for such a home. The default home still gets both blocks (SW-866).

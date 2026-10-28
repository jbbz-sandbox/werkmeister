---
"werkmeister": minor
"werkmeister-core": patch
---

SW-136: `werkmeister config` with no arguments is now read-only — it prints the resolved config (what `--show` printed) and changes nothing. Writing `config.yaml`, `env.sh`, `~/.zshenv` and the Desktop MCP config takes `--write` (the wizard on a TTY, as the bare form ran before) or a value to set (`--repos-root`, `--workspaces-root`). `--show` still works; the `--check` hints now say `werkmeister config --write`.

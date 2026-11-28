---
"werkmeister": patch
---

SW-957: `machine config --write` and `machine setup` against a relocated `WERKMEISTER_CONFIG_FILE` (or under a temp HOME) leave the Claude Desktop config alone and print `left alone (<reason>)`; `machine config --check` reports no Desktop drift there, as for `~/.zshenv` (SW-866).

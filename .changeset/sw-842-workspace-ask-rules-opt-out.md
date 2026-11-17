---
"werkmeister": patch
---

SW-842: `workspace_ask_rules: false` in `~/.werkmeister/config.yaml` turns off the six `node --test` `permissions.ask` rules every workspace's `.claude/settings.json` gets. The `--exec-runs` asks always stay, and the default keeps all of them. With it off, the next `workspace init`, `feature up`, `feature up --service` or `machine migrate` removes the `node --test` asks werkmeister wrote, keeps any added by hand, and writes none back. Only the YAML boolean `false` turns them off, and `machine setup` / `machine config` keep the key. See docs/configuration.md § workspace_ask_rules.

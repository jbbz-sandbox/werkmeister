---
"werkmeister": minor
"werkmeister-core": minor
"werkmeister-ui": minor
---

SW-577: every workspace now records an explicit model, picked by tier. `--model` takes a tier (`small`, `mid`, `frontier`, `advanced_frontier`) or an explicit model; blank means `models.default_tier` (frontier). A tier resolves at create/init through `models:` in `~/.werkmeister/config.yaml`, merged over the built-ins (claude: haiku / sonnet / opus / claude-fable-5-1; opencode: the same as `anthropic/…`), and the resolved model goes to workspace.yml and `.claude/settings.json`, so changing the config affects new workspaces only. Codex has no built-ins: set `models.codex.<tier>`, or `workspace new` on a Codex workspace, and `workspace init` in one that records no model yet, fails naming the key. Run `werkmeister machine migrate` once to write the default model into existing workspaces that record none (only `model`: their rules and hooks are left as they are). `werkmeister machine config` prints the tiers; `workspace list` and the workspace card show each workspace's model.

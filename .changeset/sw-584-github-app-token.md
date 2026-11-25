---
"werkmeister": minor
---

The PR status refresh can read GitHub as the werkmeister GitHub App (SW-584). With `app_id` under `github_ingest:` in `~/.werkmeister/config.yaml` and the App's private key as `GITHUB_APP_PRIVATE_KEY` (one base64 line) in `~/.werkmeister/secrets.env`, each refresh's per-PR `gh pr view` runs with an installation token as `GH_TOKEN`. That covers `pr watch` (the daemon's event passes and the 10-minute schedule), `pr status`, the MCP status action and close-out. Those reads count against the App's rate limit, not yours. Every other `gh` call still runs as you. If the token can't be minted, or the App's view fails, the read runs as you, logs a `warn` line, and the App is skipped for that repo owner for 10 minutes. Without both settings nothing changes. `ghs_` tokens are now scrubbed from log lines. Setup: `docs/github-ingest.md`.

---
"werkmeister": minor
"werkmeister-core": minor
---

SW-186 (breaking): the CLI is grouped by noun — `feature`, `workspace` (`ws`), `pr`, `issue`, `infra`, `machine`, `budget`, `daemon` and `internal` — e.g. `up f` is now `feature up f`, `init-workspace` is `workspace init`, `close-out --abandon` is `workspace abandon <reason>`, and the hook commands are `internal gate|pr-guard|agent-state|session-end`. Every old spelling still runs, with the same arguments, and prints one deprecation line on stderr; they are removed in 0.58.0. `werkmeister --help` lists the groups.

After upgrading, run `werkmeister machine migrate` (`--check` first to see what it would change): it rewrites each workspace's hooks, permission rules and `with-temp-home`, replaces the stale `SANDBOX_MCP_TOKEN` in `secrets.env`, and points Claude Desktop at `werkmeister internal mcp`. Upgrade the CLI and the Claude Code plugin together, and restart open Claude sessions.

Also: `feature up <f> --service <name>` starts one service (SW-132); `machine config --check` names `--write` only for problems it fixes (SW-162); new `budget status` and `daemon status|install|uninstall|restart`; gen-docs writes one man page per `noun verb`.

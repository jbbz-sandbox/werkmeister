---
"werkmeister": minor
---

SW-404: werkmeister logs its errors and diagnostics as JSON lines, with Pino. Inside a workspace they go to `.werkmeister/logs/werkmeister.jsonl`; the daemon, the MCP proxy and commands run outside a workspace write `~/.werkmeister/logs/werkmeister.jsonl`, rolled to `werkmeister.1.jsonl` past 10 MB. Each line names its app, command, workspace, run, ticket and ICM stage. The default level is `error`; `WERKMEISTER_LOG_LEVEL` or the new global `--log-level` lowers it as far as `trace` and copies lines to stderr. Secrets are redacted. Close-out writes the run's log to `logs/werkmeister.jsonl` on the record branch. Workspace verbs (create, init, up, down, pause, resume, close, abandon), gate rows and slow docker builds, installs, git fetches and Jira calls are timed into the metrics event log. See docs/logging.md.

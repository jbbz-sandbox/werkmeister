# Logging

werkmeister writes its errors and diagnostics as JSON lines, one object per line. The output you read in the terminal does not change: tables and `[ok]` lines stay on stdout. Timings are not in these logs: they are events in the metrics log, `~/.werkmeister/metrics/events-YYYY-MM.jsonl`.

## Where logs live

| Log | Path | Written by |
|---|---|---|
| Workspace log | `<workspace>/.werkmeister/logs/werkmeister.jsonl` | every command run inside the workspace folder, unless it names another workspace or feature |
| Machine log | `~/.werkmeister/logs/werkmeister.jsonl` | the daemon, the MCP session proxy, MCP tool calls, commands run outside a workspace or naming another one, and lines for a workspace already removed |
| Previous machine log | `~/.werkmeister/logs/werkmeister.1.jsonl` | the machine log, moved here when it passes 10 MB; one older file is kept |
| Close-out record | `logs/werkmeister.jsonl` on the workspace's record branch | `werkmeister workspace close` / `abandon`: the workspace log plus this run's machine-log lines, by time |

The workspace log has no size cap: it ends with the workspace. `~/.werkmeister/mcp-server.log` still exists: launchd writes the daemon's stderr there, which carries its lifecycle notices (listening, restarting after a rebuild, GitHub ingest on or off) and crash traces. The MCP session proxy's notices stay on its stderr, which Claude Code keeps in its MCP log.

Every line carries `time`, `level` and `msg`, plus what it is bound to: `app` (`cli`, `mcp` or `daemon`), `pid`, `version`, `commit`, and inside a workspace `workspace`, `run_id`, `ticket`, `stage` and `command`. Errors carry `err` with its `type`, `message` and `stack`. A failed external call carries `bin`, `args`, `code` and `stderrTail`, the last 2 KB of its stderr.

## Levels

The levels are `error`, `warn`, `info`, `debug` and `trace`. The default is `error`, written to the file only.

To see more, set a lower level. This also copies every line to stderr:

```sh
WERKMEISTER_LOG_LEVEL=info werkmeister feature up
werkmeister --log-level debug pr gate
```

`--log-level` wins over the variable. An unknown level prints one warning and logs at `error`.

| Level | What it adds |
|---|---|
| `error` | command failures, MCP tool failures, failed gate rows, failed Jira requests |
| `warn` | failed docker, compose, git and gh calls (many are probes that are expected to fail), and every `[warn]` line the command printed |
| `info` | slow calls (5 s or more): docker builds, installs, git fetches, Jira requests |

The daemon runs under launchd, whose plist sets no `WERKMEISTER_LOG_LEVEL`, so it logs at `error`.

## What is redacted

Before a line is written, werkmeister replaces these with `[redacted]`:

- the fields `token`, `password`, `secret`, `apiKey`, `authorization`, `env`, at the top level or one level down, `apiToken` and `Authorization` one level down, `headers.cookie`, `headers.authorization` and `<field>.headers.authorization`
- every value in `~/.werkmeister/secrets.env`
- the value of every environment variable whose name ends in `_TOKEN`, `_KEY`, `_SECRET` or `PASSWORD` and is 8 characters or longer
- GitHub tokens (`ghp_`, `gho_`, `github_pat_`), Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`), AWS access key IDs (`AKIA…`), and `Bearer` and `Basic` credentials

Close-out scrubs the record copy again, since the record branch is pushed.

## jq examples

One workspace's lines in the machine log:

```sh
jq -c 'select(.workspace == "sw-404-pino-logging")' ~/.werkmeister/logs/werkmeister.jsonl
```

The errors in a run:

```sh
jq -c 'select(.level == "error") | {time, command, msg, err: .err.message}' \
  <workspace>/.werkmeister/logs/werkmeister.jsonl
```

Failed external calls, with the end of their stderr:

```sh
jq -c 'select(.msg == "external call failed") | {time, bin, args, code, stderrTail}' \
  <workspace>/.werkmeister/logs/werkmeister.jsonl
```

The ten slowest workspace steps and gate rows, from the metrics log:

```sh
jq -s '[.[] | select((.event | startswith("workspace.")) or .event == "gate.row")]
  | sort_by(-.duration_ms) | .[:10] | .[] | {event, workspace, row, duration_ms, result}' \
  ~/.werkmeister/metrics/events-*.jsonl
```

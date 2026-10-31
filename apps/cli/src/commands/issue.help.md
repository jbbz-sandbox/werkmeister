## Description

Reads or updates one issue in this machine's tracker (`werkmeister machine setup` picks it).

- `view` prints the issue's briefing; `--json` prints it as JSON.
- `update` moves its status and/or adds a comment; at least one is required.
- `create` files a new issue and prints its URL. Only trackers with an API path (Jira); file GitHub issues with `gh issue create`.
- `start` moves the workspace's issue to in progress, forward only. It exits 0 when the tracker refuses, so a stage never fails on it.
- `ready` lists a project's open work in priority order: its board's ready column, else the open issues.

Inside a workspace the issue reference can be left out: it is read from `.werkmeister/workspace.yml`.

## Examples

```bash
werkmeister issue view
werkmeister issue update --status "In Review" --comment "PR opened"
werkmeister issue create --project SW --type bug --title "Short summary" --body-file body.md
werkmeister issue ready --json
```

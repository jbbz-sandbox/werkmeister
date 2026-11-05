## Description

Reads or updates one issue in this machine's tracker (`werkmeister machine setup` picks it).

- `view` prints the issue's briefing; `--json` prints it as JSON.
- `update` moves its status and/or adds a comment; at least one is required.
- `create` files a new issue and prints its URL. `--relates <key>` (repeatable) then links it "relates to" each key and prints each link; every key is checked before the issue is filed. Only trackers with an API path (Jira); file GitHub issues with `gh issue create`.
- `start` moves the workspace's issue to in progress, forward only, then fetches each code worktree's base: a branch with no commits of its own is fast-forwarded, any other gets an `N commits behind <base>` line. It exits 0 when the tracker refuses or a fetch fails, so a stage never fails on it.
- `ready` lists a project's open work in priority order: its board's ready column, else the open issues.

Inside a workspace the issue reference can be left out: it is read from `.werkmeister/workspace.yml`.

## Examples

```bash
werkmeister issue view
werkmeister issue update --status "In Review" --comment "PR opened"
werkmeister issue create --project SW --type bug --title "Short summary" --body-file body.md
werkmeister issue create --project SW --type task --title "Follow-up" --body-file body.md --relates SW-292 --relates SW-263
werkmeister issue ready --json
```

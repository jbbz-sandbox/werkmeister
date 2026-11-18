---
"werkmeister": minor
"werkmeister-core": minor
---

SW-795: `werkmeister workspace abandon "<reason>"` (and the `close-out` MCP tool with `abandon`) now moves a Jira issue to Done instead of leaving it In Progress, so an abandoned ticket leaves the queue. The comment reads `Abandoned, not shipped: <reason>` and names the branch that holds `postmortem.md`. `--keep-open` (MCP `keep_open`) puts the issue back as To Do instead, for work parked to retry later. Set `issue_statuses.abandoned: null` to keep the old comment-only behaviour.

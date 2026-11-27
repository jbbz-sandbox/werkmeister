# Werkmeister for teams

The rest of these docs assume one developer on one machine. This page covers what changes when several people use Werkmeister on the same repos and tracker: what already works, what works only partly, and what is planned. Each section starts with its status.

| Section | Status |
|---|---|
| [What a team shares, and what stays on your machine](#what-a-team-shares-and-what-stays-on-your-machine) | works today |
| [Team DORA metrics](#team-dora-metrics) | works today |
| [Onboarding a teammate](#onboarding-a-teammate) | works today |
| [Ownership and handoff](#ownership-and-handoff) | partial |
| [Review](#review) | works today |
| [Waves across people](#waves-across-people) | planned |
| [Standards governance](#standards-governance) | works today |
| [Security](#security) | works today |

## What a team shares, and what stays on your machine

**Status: works today**

Werkmeister keeps team context in git and in the tracker. Machine state stays on the machine.

| Scope | What | Where it lives | How a teammate gets it |
|---|---|---|---|
| Team | Coding standards | The standards repo, which each machine points at with `overrides.standards_dir` | `git pull` in the standards repo. Each workspace's `_shared/standards.md` points at it and doesn't copy it |
| Per repo | Services, ports, tests, release rules | The repo's `.werkmeister/services.yaml` fragment ([Registry fragments](registry-fragments.md)) | `git pull`, then `werkmeister registry` merges it into the machine registry |
| Per repo | Team work types with their own stages | `<repo>/.werkmeister/workflows/<type>/` ([ICM workflows](icm-workflows.md)) | `git pull` |
| Per workspace | The run's record: stage outputs, PR files, `postmortem.md`, `closeout.md`, `usage.json`, `metrics.jsonl` | The workspace's record branch in the workspace repo | Fetch the branch. Close-out pushes it ([Close-out](workspace-lifecycle.md#close-out)) |
| Per workspace | PR rules, standards pointers, how to file issues | `_shared/` on the record branch | Same as the record |
| Per project | Tracker, its scope and statuses | The tracker itself, and `projects:` in each person's `~/.werkmeister/config.yaml` ([Issue trackers](issue-trackers.md)) | The tracker is shared. Each person keeps their own copy of the config entry |
| Per machine, never shared | Config, secrets, tracker credentials, ports and slots, `services.local.yaml`, the metrics event log (except each closed run's own events, which close-out pushes as `metrics.jsonl` on its record branch), Claude Code transcripts | `~/.werkmeister/` and the harness's own folders | Nothing. Each person sets these up on their own machine |

Post-mortems close the loop: when a run's `postmortem.md` names a change to a standard, the post-mortem edits your standards tree (`werkmeister standards check` prints where it is) after showing you the edit ([Post-mortem](workspace-lifecycle.md#post-mortem)). Workspaces read that tree live, so the next workspace on your machine sees the change right away. Teammates see it only after you commit it to the standards repo and they pull.

### A shared dev cluster

**Status: partial**

Several people can work against one Kubernetes baseline. `werkmeister infra intercept` reroutes only requests that carry `x-feature: <feature>` to that person's laptop, so teammates and baseline traffic don't see the intercept ([`werkmeister infra intercept`](cli-reference.md#werkmeister-infra-intercept), [Topology](topology.md)). Each person runs their own intercepts, and nothing yet shows a team which features are intercepted.

## Team DORA metrics

**Status: works today**

Werkmeister writes a metrics event log on each machine, `~/.werkmeister/metrics/events-YYYY-MM.jsonl`: `issue.start`, `stage.done`, `pr.open`, `pr.merged`, `release`, `gate.start` / `gate.end`, `gate.row` (each gate row's time and kind), `test.run` (each turbo task's time, read from turbo's run summary, with test and failure counts), and `ask` / `answer`. The `metrics` MCP tool reports cycle time, lead time and waits by cause from it. `werkmeister metrics rebuild` backfills the log from record branches, GitHub and transcripts. `workspace.create` and `workspace.init` lines carry the run's `work_type`, so the `metrics` and `metrics-trends` tools (`work_type` filter) and the dashboard's Flow and Metrics tabs (work type selector) slice every number by it: `byWorkType` holds cycle and lead time, column p50/p90, waits and cost per type, and a flow card is past p90 against its own type's column, or the pooled one while its type has fewer than 5 runs there. A run with no recorded type is `unknown`; `metrics rebuild` reads older runs' types from their record branch's `workspace.yml`.

| Metric | Data Werkmeister records today | Gap |
|---|---|---|
| Deployment frequency | `release` events, each with its tag. Release tags of each repo that sets `ship: tag` and `release_tag` in its fragment | None. Each teammate's `release` events reach your report through `werkmeister metrics rebuild`, and the report counts distinct releases per week (`releases`) |
| Lead time for changes | The workspace's first Claude turn → `pr.merged` (the PR file's `merge_sha`) → `release`. The `metrics` report measures lead time from the first turn and cycle time from `issue.start`. `werkmeister pr status` finds the first release tag that contains the merge | The first commit isn't in the log. Read it from git if you want DORA's commit-to-release definition |
| Change failure rate | `gate.end` with a nonzero exit; Auto-fix commits on the PR; bugs filed from a workspace (their `Workspace:` field); abandoned workspaces (`closeout.md`); `postmortem.md` findings | No single "failed change" event. You count these by hand |
| Time to restore | The bug ticket's creation date in the tracker → the `release` that ships its fix | The tracker side isn't in the event log. Join them by ticket key |

Three more numbers matter once agents do the work:

- **Tokens and cost per workspace:** `usage.json` on each record branch, and the `workspace-usage` MCP tool.
- **Autonomous vs interactive share:** the workspace's `autonomous` setting (`--autonomous` on `werkmeister workspace new`).
- **How often a run needed a person:** `ask` / `answer` pairs and the `person` wait in the `metrics` report.

**How the team view works.** At close-out, Werkmeister copies the run's own lines of the event log into `metrics.jsonl` and pushes it with the record branch, next to `usage.json`. `werkmeister metrics rebuild` reads every record branch in the workspace repo through a temporary clone, adds each teammate's closed runs to your log, and caches each branch's `usage.json` with the branch's git author email. The `metrics` report then covers the whole team: lead time and `releases` across everyone, and `usage.byPerson` (by git author email, with lead time), `usage.byProject` (the ticket key's prefix) and `usage.byModel`. What is shared is the run's events and `usage.json`, including its cost, under the author already on the branch. A run counts only once it is closed out, and a run closed out before this version adds no `metrics.jsonl`. Run `werkmeister metrics rebuild` before the report to bring in the latest close-outs.

## Onboarding a teammate

**Status: works today**

1. Install Werkmeister and run `werkmeister machine setup` ([Quick Start](quick-start.md)). In Claude Code, the `werkmeister:setup` skill walks through it.
2. Clone the team's repos under your repos folder. `werkmeister registry` picks up their fragments.
3. Clone the team's standards repo and point `overrides.standards_dir` at it.
4. Set `overrides.workspace_repo` to the team's workspace repo, so your record branches land next to everyone else's.
5. Add your own tracker credentials and the team's project under `projects:` ([Issue trackers](issue-trackers.md)).
6. Create a first workspace for a small ticket and take it through every stage ([Users guide](users-guide.md)).

## Ownership and handoff

**Status: partial ([SW-1105](https://jory-group.atlassian.net/browse/SW-1105))**

A workspace belongs to the machine that created it. Anyone can read a run from its record branch once it is pushed: the stage outputs, the PR files and the post-mortem. Code branches are pushed at close-out and when a PR opens.

What doesn't work yet: there is no owner field, and no command that resumes someone else's workspace on another machine. Untracked files and branchless commits saved at close-out go to `handoff/<workspace>/<repo>.tgz` or `.patch` in the local Werkmeister home, out of a teammate's reach. [SW-1105](https://jory-group.atlassian.net/browse/SW-1105) plans both. To hand work over today, push the code branch and the record branch, and the teammate starts a new workspace from the ticket.

## Review

**Status: works today**

Werkmeister's checks come before normal code review and don't replace it:

- **Stage checks:** each ICM stage ends with a human check. Only the person running the workspace approves it, by flipping the output file's status or replying in chat ([ICM workflows](icm-workflows.md)).
- **PR file approval:** the PR's title and body sit in a PR file that the person sets to `approved` before `werkmeister pr open` ([PR files](workspace-lifecycle.md#pr-files)).
- **The gate:** `werkmeister pr open` runs lint, tests and the release check first, and refuses to open a PR that fails ([The gate](workspace-lifecycle.md#the-gate)).
- **Teammate review:** the opened PR is an ordinary pull request. Teammates review it and request changes as they would any other. Auto-fix answers failing checks and review comments in the session that opened it.

## Waves across people

**Status: planned ([SW-1106](https://jory-group.atlassian.net/browse/SW-1106))**

`next-wave` splits a wave by file overlap, but it only sees the workspaces in flight on your machine. Two people can each start a ticket that edits the same module and find out at rebase time. [SW-1106](https://jory-group.atlassian.net/browse/SW-1106) plans an overlap check against other people's in-flight work.

Until then, agree waves on the board: assign each ticket before starting it, and check the In Progress column for overlapping areas before running `next-wave`.

## Standards governance

**Status: works today**

Keep the standards in a git repo, so changes to them go through pull requests like code. The post-mortem edits your local standards tree. Commit that edit on a branch and open a PR to the standards repo yourself, rather than leaving it on one machine. Add a `CODEOWNERS` file there to name who must approve. Every workspace reads the standards through pointers, so once teammates pull a merged change, their next workspace has it without anyone copying it.

## Security

**Status: works today**

- **Secrets stay on the machine.** Tokens and API keys go in `~/.werkmeister/secrets.env` and per-service env files ([Configuration](configuration.md)), never in a committed fragment or a record branch.
- **What the record branch holds:** stage outputs, PR files, logs, `postmortem.md`, `closeout.md`, `usage.json`, the issue copy (`.werkmeister/issue.md`), the brief and the generated settings. Anyone with access to the workspace repo can read these, including private ticket text, so keep secrets out of stage outputs and tickets. Claude Code transcripts stay on the machine.
- **What never gets committed:** a workspace's `.env*`, `compose.yml` and `compose.gate.yml`, its `.werkmeister` runtime files (session state, token), `services.local.yaml`, and everything under `~/.werkmeister/`.
- **Workspace permissions:** each workspace's `.claude/settings.json` pre-approves only the workspace's test commands and read-only git. Everything else asks. `--autonomous` adds the git and `werkmeister` commands a headless run needs to reach `werkmeister pr open`, scoped to its own feature, plus a deny list. Use it only on tickets you would trust to run unattended.

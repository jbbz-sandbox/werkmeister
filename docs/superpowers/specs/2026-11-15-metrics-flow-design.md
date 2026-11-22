# Metrics and flow: where werkmeister work waits

Spike SW-772, decided 2026-11-15. Nothing here is built yet. The follow-up tickets in § Follow-up tickets build it. The event format is [2026-11-15-metrics-events.schema.json](2026-11-15-metrics-events.schema.json), and the analytics page mock is [2026-11-15-metrics-flow-wireframe.html](2026-11-15-metrics-flow-wireframe.html).

Paths below are relative to `packages/werkmeister-core/src/` unless they start with `apps/`. File:line references are to `main` at 1dbfac70.

werkmeister owns these metrics. Nothing reads ponytail's files, and nothing needs ponytail installed. The ponytail board (`~/.config/ponytail/band/board.html`) was a design reference only and was not read as data.

## Why

Today `workspace-usage` gives one run's usage, and the dashboard shows each workspace's current state. Nothing shows behaviour over time or where work waits. The ticket's examples from 2026-11-14/15:

- workspaces waited 45-48 minutes for host capacity while the one running container sat at about 0% CPU under a 6-CPU budget;
- sessions (sw-753, sw-749) looked "thinking" for hours after their last real activity;
- two related tickets ran in parallel and one had to be reworked on rebase (SW-748 / SW-749, SW-767).

The week of 2026-11-08 to 2026-11-15, measured from what werkmeister and its neighbours keep (commands in § Sources):

| Measure | Value |
|---|---|
| PRs merged | 80 (51 excluding "version packages") |
| PR open → merge, non-release | p50 15 min · p75 52 · p90 145 · max 844 |
| Workspaces closed | 68, all shipped |
| Workspace wall clock | p50 284 min · p90 842 |
| Stage minutes, p50 / p90 | 01 research 11 / 204 · 02 spec 1 / 83 · 03 implement 157 / 796 · 04 propose 48 / 287 |
| Negative stage durations | 14 of 265 this week, 38 of 923 since 2026-10-30 (SW-774) |
| Cost | null in 237 of 237 closed workspaces (SW-773) |
| Questions to the person | 378 asks: wait p50 1.9 min · p90 40 min · max 686 min · **118 agent-hours in total** |
| Silent gaps ≥ 30 min between turns | 86: p50 83 min · p90 333 min · 185 h in total |
| Capacity waits | **not measurable**: see § Q2 |

Waiting on a person is the largest bottleneck by an order of magnitude. Capacity waits may be second, but nothing records them.

## Q1 Kanban flow: columns and charts

### Columns

**Recommendation:** four columns. A wait shows as a badge on the card, not as a column of its own.

| Candidate | Decision | Reason |
|---|---|---|
| working | kept | The ICM stage (01-04) shows as a chip on the card. Stage is the useful split (03 implement p90 is 796 min), but four more columns crowd a board of 2-6 cards. |
| ready (PR file approved, gate not yet passed) | kept | Gate runs and exit-75 retries sit here. |
| pr-open | kept, covering CI and the merge queue | p50 15 min, p90 145: short enough for one column. |
| merged + shipped | merged into **awaiting release** | They differ only by the release tag. The person needs to know "not released yet". |
| closed-out | dropped from the board | Done work counts in throughput and cycle time. The board shows open work. |
| ICM stages 01-04 as columns | dropped, shown as a chip | too wide for few cards |
| waiting for host capacity · on a person · for CI or merge queue · for a release | **badge** with the minutes waited, on the card in its current column | Waits happen inside a column (person and capacity inside working, CI inside pr-open). Wait columns would bounce cards back and forth. "On a person" is the badge that matters most (118 h this week). |

Rejected: one column per ICM stage (too wide), and separate wait columns (cards bounce between them, and § Q5's wait-by-cause chart already shows the split).

### Charts, for one person running a few workspaces

**Recommendation:**

| Chart | Decision | Reason |
|---|---|---|
| Aging work in progress | **kept**, the main chart | Answers "stuck now": each open card's age against that column's past p50 and p90. |
| Cycle time per ticket | **kept** | A scatter with p50 and p90 lines shows outliers and trend. |
| Lead time per ticket | kept as a toggle on the cycle-time scatter | Same axes, a different start point (see § Definitions). |
| Blocked time | **kept**, as wait time by cause | Weekly stacked bars by cause (§ Q5). |
| Cumulative flow diagram | **dropped** | With 2-6 items in flow, the bands are a few pixels high. Aging and the scatter show the same thing. Revisit if WIP often passes about 10. |
| WIP limits per column | **dropped** | The capacity scheduler already enforces the real limit (slots and the CPU budget). Each column header shows its current WIP count instead. |

Rejected: all five as the ticket lists them (the CFD and WIP limits add nothing at this scale).

## Q2 Bottlenecks: what proves each one

**Recommendation:** measure each bottleneck as below. Two of them need new events (§ Q3).

| Bottleneck | Measure that proves it | Measurable today? |
|---|---|---|
| Capacity queue wait | Per admission: `queue.admit.waited_s`, beside host CPU at that time. Proven when the p90 wait is long while measured CPU is low. | **No.** `waiting.json` is deleted on admit (`clearWaiting`, `scheduler_state.ts:503`). `queue.json` has no times. `pr-open.log` prints "Waiting for capacity … position 1" with no timestamp. |
| Idle with a question open | Per question: `answer.at − ask.at`, and that wait as a share of wall clock | Yes, from transcripts: 378 asks, p90 40 min, 118 h this week |
| PR open → merge | GitHub `mergedAt − createdAt`. That covers CI, the person's review and merge, and the merge queue together. Splitting off the person's part needs the merge-queue enqueue time (github-ingest's `pull_request/enqueued`), a later addition. | Yes: p50 15 min, p90 145 |
| Gate runs and exit-75 retries | Gate runs per workspace, first-pass rate, retries per run, minutes lost to retries | **No.** Gate logs are overwritten each run and committed only after a successful `pr open` (`pr_lifecycle.ts:1846-1853`). Retries are not counted (exit 75 comes from `apps/cli/src/commands/pr.ts:75` and `apps/cli/src/commands/wait_load.ts:22`). |
| Rebase rework | Commits and changed lines pushed after the PR's first push; gate reruns after a rebase; tickets whose PRs touched the same files while both were open | Yes, from git and GitHub (commits after `createdAt`, each PR's file list) |

Rejected: inferring capacity waits from transcript tool-call durations (they mix the wait with the command's own run time), and measuring idle time as "no output for N minutes" (a long test run looks the same as a stuck session; the ask/answer pair says who is waiting on whom).

## Q3 Events: recorded today and to add

### Already recorded or derivable

| Event | Recorded? | Timestamp source | Where | Kept after close-out? |
|---|---|---|---|---|
| Stage end | derived | newest output-file mtime | `stageTimings`, `usage_snapshot.ts:72-108` | frozen in `usage.json` on the record branch; can go negative (SW-774) |
| Stage start | no | — | — | — |
| Queue waiting | current state only | `since` in `<ws>/.werkmeister/waiting.json` | `requestAdmission`, `scheduler_state.ts:492-500` | no (the file is overwritten, then deleted) |
| Queue admitted | no | — | `clearWaiting`, `scheduler_state.ts:503` | — |
| Session started, busy, idle | current state only | `at`, `last`, `tool.at` | `nextSession`, `agent_state.ts:264-410` | no (`sessions/` is deleted on SessionEnd and gitignored) |
| Session resumed | derived | transcript `timestamp` | `harness/claude/usage.ts:42` | transcripts only, pruned after about 30 days |
| Question asked | current state only | `ask.at` | `agent_state.ts:316-379` | no |
| Question answered | derived | transcript `tool_result` timestamp | — | transcripts only |
| PR opened | partial | `notified_review` (overwritten later); record commit "chore: record opened PR(s)" | `pr_lifecycle.ts:1798-1805`, `:1853` | the record-branch commit |
| PR merged | derived | record commit "chore: record PR status"; GitHub `mergedAt` (not read today) | `pr_lifecycle.ts:1934-1939`, `:2006` | the record-branch commit |
| Merge queue in and out | derived | github-ingest webhook | daemon log `~/.werkmeister/sandbox-mcp.log` | log only, no time on the line |
| Gate started, result | derived | log mtime; `last-exec` marker | `pr_lifecycle.ts:947-950`; `apps/cli/src/commands/pr.ts:66-75` | last successful run only |
| Release tagged | derived | git tag creatordate | `pr_lifecycle.ts:1964,1985` | PR frontmatter, no time |
| Issue status move | logged since SW-1034: `issue.start` | Jira changelog (never read) | `startIssue`, `issue_status.ts` | the metrics log |
| Workspace closed out | **yes** | `closedAt`, `firstTurn`, per-session first and last turn | `buildUsageSnapshot`, `usage_snapshot.ts:126-178`, written at `:244-262` | **yes**: `usage.json` is pushed to the record branch before the folder is removed (`sandbox.ts:2933-2940`). 237 survive from 2026-10-30 on. |

### To add: the minimum

**Recommendation:** ten events in one append-only log, each written where the state is already written, so no new hook points are needed. The shape is the [schema](2026-11-15-metrics-events.schema.json).

| Event | Written beside | Proves |
|---|---|---|
| `queue.wait`, `queue.admit` (with `waited_s`) | the `writeWaiting` / `clearWaiting` calls in `requestAdmission` (`scheduler_state.ts:492-503`; both are defined at `agent_state.ts:494-499`). `queue.wait` only when no `waiting.json` existed before the write, since a queued feature re-asks and rewrites it. `queue.admit` only when one existed, with `waited_s` taken from its `since`, since `clearWaiting` also runs on admissions that never waited. | capacity wait |
| `queue.preempt` (victim, its `rank`, `for`) | each victim's stop in `admitOrQueueHere` (`lifecycle.ts`), added in SW-989 | who preemption stopped, and for whom |
| `ask`, `answer` (with `waited_s`) | `ask` where `s.ask` is set (`agent_state.ts:316-328`). `answer` at the PostToolUse of that ask's own tool (AskUserQuestion, ExitPlanMode), or at the next prompt for a wrap-up ask, and only when an ask was open. It is not written where `s.ask` is deleted: that runs on every other tool call and prompt (`agent_state.ts:296-330`). This matches how § Why measured the 118 h (`tool_use` → `tool_result`). | waiting on a person |
| `stage.done` | the record-branch commit that first fills a stage's `output/` | stage time, replacing the mtime guess (SW-774) |
| `gate.start`, `gate.end` (exit code, retry count) | the gate runner, `pr_lifecycle.ts:947-950`; `apps/cli/src/commands/pr.ts:66-75` | gate first-pass rate, retry loss |
| `pr.open`, `pr.merged`, `release` | where PR status is written, `pr_lifecycle.ts:1805,1939,1985`, using GitHub `createdAt`/`mergedAt` and the tag date | CI and queue time, release wait |

Still derived, no new logging: session start, resume and idle (transcripts), closed-out (`usage.json.closedAt`).

SW-404 (Pino structured logging, stage transitions and timings) writes through the same writer: one log, not two.

Rejected: logging every agent-state change, such as idle and busy flips (high volume, and transcripts already hold it while it is fresh), and only the two unmeasurable events (stage and PR times would stay on mtimes and record commits, which already go wrong, as SW-774 shows).

## Q4 Storage and retention

| Option | For | Against |
|---|---|---|
| Append-only per-project CSV, as ponytail does | trivial, greppable | Fixed columns: events of different shapes don't fit, and it holds one row per session at most. |
| **JSONL event log under `~/.werkmeister/metrics/`** | Append-only, any event shape, outside the workspace so it survives close-out, and rollups can be rebuilt. No dependency. | A reader aggregates on load, which is fine at about 10k lines a month. |
| SQLite | queries | No SQLite in the repo. `node:sqlite` prints `ExperimentalWarning` on Node 24.13.1. A binary file is harder to inspect and rebuild. |
| Derive from existing sources only | no new writes | Capacity waits and gate retries are in no source. Transcripts are pruned after about 30 days (the oldest on this machine is 2026-10-17). Record branches have no event times. |

**Recommendation:**

- **Raw events:** `~/.werkmeister/metrics/events-YYYY-MM.jsonl`, one file a month. Each event is one `fs.appendFileSync(path, line + "\n")` call, a single `write()` on an `O_APPEND` file, so lines from concurrent processes don't interleave. Lines stay under 4096 bytes as a sanity cap only (that number is the pipe limit, not a file guarantee). Kept **forever**: a few KB a day.
- **Per-workspace rollup:** stays the existing `usage.json`, which close-out already pushes to the record branch. It survives workspace deletion today.
- **Rebuild:** `werkmeister metrics rebuild` re-derives what it can from record branches (237 `usage.json` files), GitHub and the transcripts still on disk. Run it before transcripts age out to keep their ask/answer times.
- **Privacy:** everything stays on the machine. The dashboard already binds to loopback (`apps/werkmeister-dashboard/src/main.ts:14`). No event carries prompt or transcript text, only ids, times and counts.
- SW-403's `workspaces.csv` ledger becomes a view computed from this log, not a second source.

Rejected: a 1-year retention with rollups (the data is tiny, and trends by release need the full history), SQLite (an experimental runtime module, or a new dependency, for queries a JSONL scan answers), and CSV (fixed columns).

## Q5 Analytics page

**Recommendation:** a sixth dashboard tab, **Flow**. See the [wireframe](2026-11-15-metrics-flow-wireframe.html).

- **Range:** 7d / 30d / 90d / All, **default 7d**. 90d and All need the event log, because transcripts are pruned at about 30 days.
- **The single glance:** the top of the page is the flow board (§ Q1) with each card's age and wait badge. A card turns red when it is older than its column's p90. That answers "where is my work stuck right now".
- **Middle:** wait time by cause (person, capacity, PR open → merge, gate retries, release), stacked by week, and the cycle-time scatter with its lead-time toggle.
- **Bottom:** tiles for cost, tokens with cache-read share, active versus wall time, and turns, plus agent time per day as bars.
- **Drill-down:** card → workspace timeline (stage bars, wait blocks, gate runs, PR) → session row (first and last turn, turns, tokens, cost) → the existing session picker.
- **Plumbing:** one new MCP tool, `metrics`, called through the existing `/api/tool` path (`apps/werkmeister-dashboard/src/browser-main.tsx:30`). Charts are inline SVG, since the repo has no charting dependency. The tab touches `browser-main.tsx:85-105,178-180`.
- The ticket's sketch names a cumulative flow chart. It is left out per § Q1.

Rejected: folding the charts into the Health tab (it answers "is the machine healthy", a different question, and it would bury the board), a static `board.html` as SW-403 first proposed (a second UI beside the dashboard), and a 30-day default (with 2-6 items in flow, a week shows what is stuck now; 30d is one click away).

## Q6 ponytail metrics, from werkmeister's own data

**Recommendation:**

| Metric | Decision | werkmeister source |
|---|---|---|
| Agent time | **compute differently**: active time (§ Definitions) beside wall clock, so idle time shows | transcripts (`harness/claude/usage.ts`), frozen into `usage.json` at close-out |
| Cost | keep, once SW-773 adds current models to the price table | `workspace-usage` / `usage.json.estUsd` |
| Tokens | keep, with cache-read share | `usage.json.totals` |
| Turns | keep, in the session table only | `usage.json.turns` |
| Tests status | **compute differently**: gate first-pass rate, and pass or fail per gate run | `gate.end` events |
| Per-day activity | keep | event log and transcripts |
| Active days and streak | **drop** | Not a flow measure, and per-day activity shows the same thing. |
| Reuse % | **drop** | It needs ponytail's own measurement, which no werkmeister data holds. The nearest werkmeister measure, cache-read share of input tokens, is already shown with tokens. |
| Model | keep, as the by-model split | `usage.json.byModel` |
| Level | drop | a ponytail concept |

Every kept metric works with ponytail not installed.

Rejected: keeping streaks as a small tile (it rewards activity, not flow), and relabelling cache-read share as "reuse" (it measures something different under the same name).

## Q7 Scope with SW-403

**Recommendation:** this spike **feeds and narrows** SW-403.

- SW-403 keeps the quality metrics: gate first-pass rate, coverage (SW-405), and cost per shipped ticket split by werkmeister version.
- This spike supplies the flow half (columns, waits, bottleneck measures) and the storage. SW-403's `workspaces.csv` becomes a view over the event log, and its `board.html` becomes the Flow tab.

Rejected: replacing SW-403 (it carries coverage and quality metrics this spike does not decide), and keeping both separate (two ledgers and two boards for the same data).

## Definitions

The follow-ups implement these exactly:

- **Wait by cause**, per workspace over the range:
  - person = Σ `answer.waited_s`
  - capacity = Σ `queue.admit.waited_s`
  - PR open → merge = `pr.merged.at` − `pr.open.at`: CI, review, the person's merge and the merge queue together (the person merges by hand)
  - gate retries = Σ(`gate.end.at` − `gate.start.at`) over runs whose `exit` is 75 ("retry later": host load or capacity, `apps/cli/src/commands/pr.ts:75`). Runs with any other non-zero exit are gate failures, a quality measure, not a wait.
  - release = `release.at` − `pr.merged.at`
- **Cycle time** runs from issue In Progress (the `issue.start` event `werkmeister issue start` writes, or else the workspace's first turn) to `pr.merged`.
- **Lead time** runs from the workspace's first turn to `release`, or to `pr.merged` when the repo ships with no tag.
- **Aging WIP** compares an open card's time in its current column with that column's p50 and p90 over the selected range. A card past p90 turns red.
- **Active time** is the sum of the gaps between consecutive transcript messages that are under 5 minutes. It is shown beside wall clock.
- **Gate first-pass rate** = workspaces whose first gate run that finished (exit ≠ 75) has `exit` 0 ÷ workspaces with any finished gate run. Exit-75 retries don't count against it.

## Bugs found

- [SW-773](https://jory-group.atlassian.net/browse/SW-773): `model-pricing.yaml` and its defaults (`harness/claude/usage.ts:112-117`) list no current model, so `estUsd` is null in every run.
- [SW-774](https://jory-group.atlassian.net/browse/SW-774): `stageTimings` takes the newest output mtime, so a stage edited later makes the next stage's duration negative.

## Follow-up tickets

Each one fits one workspace, and each is linked "relates to" SW-772 and SW-403. "Blocked by" is a Jira "blocks" link.

| # | Key | Ticket | Blocked by |
|---|---|---|---|
| F1 | [SW-775](https://jory-group.atlassian.net/browse/SW-775) | Metrics event log: append-only `~/.werkmeister/metrics/events-YYYY-MM.jsonl` writer, schema test, and `queue.wait` / `queue.admit` | — |
| F2 | [SW-776](https://jory-group.atlassian.net/browse/SW-776) | Metrics events: `ask` / `answer` from the agent-state hooks | SW-775 (F1) |
| F3 | [SW-777](https://jory-group.atlassian.net/browse/SW-777) | Metrics events: `stage.done` at the record commit that fills a stage's output | SW-775 (F1) |
| F4 | [SW-778](https://jory-group.atlassian.net/browse/SW-778) | Metrics events: `gate.start` / `gate.end` with exit code and retry count | SW-775 (F1) |
| F5 | [SW-779](https://jory-group.atlassian.net/browse/SW-779) | Metrics events: `pr.open` / `pr.merged` / `release` from GitHub times and the tag date | SW-775 (F1) |
| F6 | [SW-780](https://jory-group.atlassian.net/browse/SW-780) | `werkmeister metrics rebuild`: backfill from record branches, GitHub and transcripts | SW-775 (F1) |
| F7 | [SW-781](https://jory-group.atlassian.net/browse/SW-781) | `metrics` MCP tool: flow board, waits by cause, cycle time and cost over a range | SW-775 (F1) |
| F8 | [SW-782](https://jory-group.atlassian.net/browse/SW-782) | Dashboard Flow tab: board with aging and wait badges | SW-781 (F7) |
| F9 | [SW-783](https://jory-group.atlassian.net/browse/SW-783) | Dashboard Flow tab: wait-by-cause, cycle-time scatter, cost and agent-time tiles | SW-782 (F8) |
| F10 | [SW-784](https://jory-group.atlassian.net/browse/SW-784) | Active time beside wall clock in `workspace-usage` and `usage.json` | — |

## Sources

All numbers are from 2026-11-15 and are local or read-only:

- PRs: `gh pr list --repo jbbz-sandbox/werkmeister --state merged --limit 80 --search "merged:>=2026-11-08" --json number,title,createdAt,mergedAt`, with release PRs dropped by title ("version packages").
- Workspaces and stages: `usage.json` from each workspace record branch, fetched with `git fetch origin '+refs/heads/<user>/*:refs/rec/*'` (291 branches, 237 with `usage.json`), filtered on `closedAt >= 2026-11-08`. Negative stage minutes are left out of the percentiles.
- Questions and gaps: Claude transcripts `~/.claude/projects/<encoded workspaces root>-sw-*/*.jsonl` changed since 2026-11-08. Question wait is the `AskUserQuestion` `tool_use` timestamp to its `tool_result` timestamp. Gaps are consecutive message timestamps 30 minutes or more apart.
- Capacity: `~/.werkmeister/scheduler/queue.json` and `leases.json` (no times), and the `pr-open.log` files on the record branches (no timestamps).
- Transcript retention: the oldest transcript on this machine has an mtime of 2026-10-17. That matches Claude Code's 30-day default cleanup, which comes from its docs and was not checked another way.

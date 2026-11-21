---
name: triage
description: Use when asked to triage, groom, prioritize, reorder or "check" a project's Jira backlog or board (a project under projects: in ~/.werkmeister/config.yaml), when new issues need placing, when the weekly backlog report or notification comes up, or on "/triage".
---

# triage

The board order is the priority, and the priority field is only a rough tier (High / Medium / Low). Triage places new issues and repairs the order. **You propose, the person approves, then you apply.** `/next-wave` reads this order, so triage before a wave when the report shows new issues.

**Project rules.** The project's own instructions (the CLAUDE.md files in your context) can add placement rules, links to add, report flags and a group cap. Read them before step 1 and apply them on top of the rules below; with none, the rules below are the whole set. Keep priorities matching position either way, because `/next-wave` sorts by priority before rank.

Scripts sit next to this file: `S="${CLAUDE_PLUGIN_ROOT}/skills/triage"`.

## Steps

0. **Project.** Pick the project as `werkmeister issue ready` does: the one the person names, else the workspace's (`project:` in its workspace.yml), else the `default: true` one under `projects:`, else the only one (`werkmeister machine config --show` prints them). Tracker `github`: say triage handles Jira projects only for now and stop. No `board:`: say triage needs `board: { id, ready }` on the project and stop. Otherwise `KEY` = `tracker.project`, `BOARD` = `board.id`. No `projects:` at all: ask the person for the Jira key and board id. Credentials come from the `jira:` block of `~/.werkmeister/config.yaml`.
1. **Report.** `python3 -I $S/report.py --project $KEY --board $BOARD`, plus any flags the project's instructions add. It only reads. Add `--out ~/.cache/backlog-triage/reports/$(date +%F).md` to keep a copy.
2. **Read the new issues** in full: description, links, and whether a workspace is already on it (`werkmeister workspace list`, the CLI).
3. **Propose** one table: key, summary, proposed priority, and position (the whole open order, top to bottom). List separately the links to add, the priority changes, and likely duplicates. Order by these rules:
   1. Work in progress first: In Review, then In Progress. Finish before starting.
   2. Then To Do, by value: bugs that break daily work or CI, then the current theme, then everything else.
   3. Every blocker sits above what it blocks.
   4. Any placement rule the project's instructions add (for example, a step ranked just above the tickets it should close).
   5. Work the person has parked or isn't doing goes at the bottom as Low. Priority never rises down the order: a Low card above Medium ones is either parked (move it down) or mis-tiered (raise it).
   6. Epics go last. They aren't cards.

   Also list likely duplicates by topic, not title (e.g. two tickets asking the gate to run `biome ci`), and the links the project's instructions ask for.

   Then propose **groups**: one workspace and one PR for tickets that would otherwise each pay for their own stages and gate run. `/next-wave` only reads groups, so they are made here. Show them as `lead ← members` with the shared file or text, under the order table.
   - Give every open ticket one Jira component from § Components. The report's "No component" section lists the ones without. List the assignments beside the order table.
   - Group by component: tickets with the same component form one group of up to 15 tickets, unless the project's instructions set another cap. Code-logic bugs included. Leave out stories, tickets for another repo, and tickets that overlap a running workspace (they wait for the next group). Split a larger set by rank. Tickets that change the same function always share a group.
   - The lead is the group's highest-ranked ticket; the group runs at the lead's rank, so members keep their own rank.
   - Never group a big story, a blocked ticket, a ticket that leaves a design choice to the person, or a ticket the project's instructions keep alone, with anything else.
   - Extend an open group (its lead has a `Grouped PR (triage …)` comment) instead of starting a second one for the same component. A member whose lead is in flight (has a workspace) waits for the next group.
   - Check existing groups' members against merged PR titles (`gh pr list -R <owner/repo> --state merged`, for each repo the project's tickets land in): a member that shipped gets closed, not left in the group.
4. **Wait for approval.** It's a bulk edit.
5. **Apply** (calls through the `jira` skill):
   - priorities with `PUT /rest/api/3/issue/KEY`
   - links (direction in the `jira` skill)
   - components: `PUT /rest/api/3/issue/KEY` with `{"fields":{"components":[{"name":"<component>"}]}}`. A configured component the tracker doesn't have yet is made first: `POST /rest/api/3/component` with `{"project":"<KEY>","name":"<component>","description":"<what it covers>"}`.
   - groups: on each lead, a comment `Grouped PR (triage YYYY-MM-DD): <lead> leads one workspace and one PR for <members>. One commit per ticket so each can be reverted alone. Close each member when the PR ships.` (members as inline cards), and a "relates to" link from each member to the lead. When a group is extended, post a new comment with the full member list; the newest comment wins.
   - then the order: `python3 -I $S/rank.py KEY KEY ...` with the full order. It ranks one at a time and checks itself.
6. **Verify** by rerunning the report: "Order problems" and "not linked" should be empty. "Order problems" covers rules 1 and 3–6 (`--self-test` checks those rules offline). A rank call can return 204 without moving the card, so trust the report, not the status code. Then `python3 -I $S/report.py --project $KEY --mark`, so next time only issues created after now count as new.

## Components

One per ticket: the subsystem its fix lands in. They are the grouping key (step 3).

The list is the project's own, not this skill's: `repo.components` in the repo's `.werkmeister/services.yaml` (the repo the project's tickets land in), a map of component name to what it covers. `werkmeister registry sync` copies it to `repos.<repo>.components` in `~/.werkmeister/services.yaml`. Read the repo's file, so a list merged today is used today.

- No `repo.components`: propose a list with the order table (about a dozen, from the open tickets' subsystems) and stop. Group nothing until the person has merged it into the repo.
- A set of tickets fits none: propose the new component with the order table. It is a change to that file, through a PR, never a name made up in the tracker.

## What the report flags

| Section | Usual fix |
|---|---|
| New since last triage | Place it (step 3) |
| No component | Assign one from § Components (step 3) |
| Order problems | Move the blocker up or the blocked item down; work in progress to the top; with `--epic-steps`, a step's "relates to" ticket to just below that step; a Low card above higher ones down (parked) or its priority up; epics to the end |
| Dependency written but not linked | Add a "blocks" link (the description's "Depends on" was never linked) |
| In Review for over 7 days | Ask the person: merge, nudge or drop |
| To Do with no update for 30+ days | Ask the person: keep (and re-place), or close |

## Schedule

A per-machine option; the plugin installs nothing. A launchd agent (or cron) can run `report.py --notify` weekly. It only reads and doesn't start Claude; the person runs this skill to act on it. Point it at the plugin copy, with the project's flags, e.g. `ProgramArguments`: `/bin/zsh -c 'python3 -I ~/repos/werkmeister/plugins/werkmeister/skills/triage/report.py --project SW --board 1 --epic-steps --notify --out ~/.cache/backlog-triage/reports/$(date +%F).md >/dev/null'`, `StartCalendarInterval` Monday 09:00, `StandardErrorPath` `~/.cache/backlog-triage/reports/launchd.log`. The last-triage mark (`~/.cache/backlog-triage/<KEY>-last-triage`) is shared by every copy of `report.py`.

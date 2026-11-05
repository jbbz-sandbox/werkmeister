---
name: next-wave
description: Use when the person wants the next batch of tickets from a project's tracker (Jira or GitHub issues, or its board) turned into feature workspaces and started — "pull another wave", "next wave", "/next-wave", "create workspaces for the open tickets", "start the ones that are safe to run autonomously".
---

# next-wave

Turn a project's open tickets into a set of workspaces that can run **at the same time without stepping on each other**, mark each one autonomous or interactive, and start them as Claude Code sessions with Remote Control on. The root session plans and starts; it never does a ticket's work itself.

No UI: don't call the werkmeister MCP tools that render the workspaces dashboard (`list-workspaces`, `status`, `open-workspaces-ui`). Everything here comes from Jira, `gh`, `git` and the `werkmeister` CLI.

## 1. Read the tickets

- Open tickets, in priority order. On a machine with `projects:` in `~/.werkmeister/config.yaml`: `werkmeister issue ready --project <name> --json`, which lists the project's board's ready column in board rank when the project has a board, else the scope's open issues (users guide § Projects). With no projects: Jira REST `search/jql` with `project=<KEY> AND statusCategory != Done ORDER BY priority DESC, rank ASC` and `fields=summary,status,priority,description,issuelinks` (credentials: the `jira:` block in `~/.werkmeister/config.yaml`). Then `werkmeister issue view <ref>` per ticket for its description and links. Read the summary and description of each; the description decides the classification below. Keep this order: it decides who goes first in step 3.
- Links: an `is blocked by` link to a ticket that isn't Done makes the ticket **Blocked**, whatever its description says.
- Already in flight: `werkmeister workspace list` (the CLI, a plain table of workspace, issue and labels) — any ticket that already has a workspace is not in this wave.
- Recently merged: `gh pr list --state merged` — a ticket that "waits for X" is unblocked only if X is merged (or released, if it says so).

## 2. Classify every ticket

| Bucket | Signals | This wave? |
|---|---|---|
| **Not code** | buy a domain, legal/attorney, CLA app install, trademark search, research or launch write-up | No. List it as manual. |
| **Blocked** | an open `is blocked by` link; "after the deprecation period"; "after X merges"; "N release(s) after X ships" (blocked until N releases after the one containing X are published: check the package's tags); or needs a ticket in this wave or already in flight | No. Name what it waits for. |
| **Other repo** | the change lives outside the repo the wave targets | No, unless the person asks; then interactive. |
| **Autonomous** | mechanical or well-specified, verifiable with unit tests and mocks, no live infra, no decision left to the person | Yes, `--autonomous` |
| **Interactive** | touches the person's machine state (crontab, `~/.claude`, real `~/.werkmeister`), needs a live cluster / Telepresence / a real tracker to verify, or leaves a design choice to the person | Yes, interactive |

Model per ticket: `--model sonnet` for mechanical work (renames, lint/tsc fixes, license files, doc sweeps); default model for design or bug-hunting.

## 3. Pick the wave: no two tickets in the same files

**Groups first.** Triage groups tickets that change the same text or files under a lead. The lead carries a comment starting `Grouped PR (triage …)` that lists its members, and each member "relates to" the lead. Fold every open member into its lead: the group is one candidate, ranked where the lead is, whose files are the union of its members' files. A member is never a candidate on its own, even when its lead is blocked or deferred (then the whole group waits). A Done member drops out. If a member was later moved under another lead, the newest comment wins. Don't make new groups here; that is triage's job.

Estimate the functions each candidate changes (paths and identifiers named in the ticket, plus `git grep` for them). Compare every candidate against the others **and against tickets already in flight** (their workspaces from `werkmeister workspace list`). Walk the candidates in priority order. Two tickets that change the **same function** go in different waves: keep the higher-priority one (on a tie, the one that unblocks more), defer the other and say why. Different functions in the same file are allowed in one wave; note the shared file so the later PR expects a rebase. Shared test files and CHANGELOGs never count.

Show the person the wave as one table — ticket, autonomous or interactive, model, reason — plus the deferred list with a reason each. Then create without waiting unless they object.

## 4. Create the workspaces, one at a time

One `werkmeister workspace new` per ticket, **in sequence** (they share source repos), in the background:

```bash
werkmeister workspace new <slug> --issue-id <ref> --repos <repo> \
  [--services <only what the ticket says to run or measures>] --work-type <feature|bugfix|refactor|spike> \
  --labels focus [--group <member keys>] [--autonomous] [--model sonnet]
```

- Before the first create: the code checkout the CLI runs from is on an up-to-date `main` and rebuilt (`pnpm run build` at its root; the plugin's MCP server runs `apps/werkmeister-mcp/dist`).
- A group gets one workspace, for its lead: `--group <member keys, comma-separated>`, so the ICM contracts render the grouped PR (one commit per ticket). Its starting prompt names every member and says to close the members when the PR ships. Check that `group:` appears in its `workspace.yml`.
- List only the services the ticket says to run (usually none), and any service whose container the ticket measures or exercises (memory, cold build or gate timings, its runtime): without it `werkmeister feature up` starts nothing and the run measures in a throwaway container (SW-280). The gate starts each touched service's container that isn't running and stops it again (SW-34, SW-336), so zero services is fine for a plain code change. Every listed service is a container plus an install and build on `werkmeister feature up`, so extra ones cost real CPU (SW-28).
- Batch check each one: the workspace dir holds `.werkmeister/issue.md` and `CLAUDE.md` has a `## Issue` section.
- The CLI writes `starting_prompt` from the ticket. When you edit one by hand, don't copy in a step that writes machine state (`werkmeister registry sync`, `werkmeister infra proxy-reload`, `npm link`, global installs) as a run step: the run limits forbid it. Say it happens after merge instead, e.g. "the next `registry sync` after merge picks up the fragment edit". The CLI drops such steps from the distilled prompt and the autonomous brief too (SW-296).

## 5. Start each one with Remote Control on

`werkmeister workspace prompt --args --start <workspace dir>` prints the run's `title`, `model`, `prompt` and `background` as JSON: the same ones the pane's ▶ Start work sends, with the run limits (autonomous) or the interactive line already in `prompt`. An autonomous workspace's `BRIEF.md` carries the same limits from create. For an interactive one, append the decisions it must ask about to `prompt`.

Every run starts with Remote Control on, so the person can follow and answer it from claude.ai/code or the Claude app. On macOS, start each one in its own Terminal window, **one at a time**, from a launcher in your scratchpad (`$S`). A `.command` file opens in Terminal and keeps the prompt's quotes and newlines intact:

```bash
D=<workspace dir>; W=$(basename "$D")
werkmeister workspace prompt --args --start "$D" > "$S/$W.json"
jq -r '[.background, .prompt] | map(select(.)) | join("\n\n")' "$S/$W.json" > "$S/$W.prompt"   # then append any interactive decisions
m=$(jq -r '.model // empty' "$S/$W.json")
printf '#!/bin/bash\ncd %q && exec claude "$(cat %q)" --remote-control %q%s\n' "$D" "$S/$W.prompt" "$W" "${m:+ --model $m}" > "$S/$W.command"
chmod +x "$S/$W.command" && open -a Terminal "$S/$W.command"
```

Confirm each one with `pgrep -f -- "--remote-control $W"`. Under heavy load a window can take a minute to open. Report each session's Remote Control name (`$W`).

When the person asks for Claude Desktop instead: `start_session` with `title`, `model`, `prompt` and `background` unchanged, `initiation: "user_asked"`, `cwd` = the workspace dir, `use_worktree: false`, `context: "fresh"`, one message each preceded by a bold title line, with a chapter marked first when starting two or more. It has no Remote Control option, so tell the person to type `/remote-control` in each session it opens.

Everything started carries the `focus` label (set at create, or `werkmeister workspace init --labels focus`), so `/check-in` cycles only this wave.

## Common mistakes

| Mistake | What happens | Do instead |
|---|---|---|
| Two tickets that edit the same module in one wave | Rebases and conflicts for every later PR | Split by file overlap (step 3) |
| Creating workspaces in parallel | Worktree and slot races on the shared source repo | One `werkmeister workspace new` at a time |
| Every service on every workspace | Watchers and parallel installs saturate the host (load 155 with 5 runs) | Only what the ticket says to run; stop after `pr open` |
| Starting a ticket that waits on an unmerged or unreleased one | Wasted run, or a PR built on stale main | Classify it Blocked |
| Running headless (`claude-send`), or a launcher without Remote Control | Nothing to watch or answer from claude.ai/code or the app | The step 5 launcher with `--remote-control` |
| Putting the prompt inline in `osascript … do script` | Its quotes and newlines break the command; the window runs nothing | The `.command` launcher in step 5 |

## Stop when

Every ticket in the wave has a workspace and a started session with Remote Control on, labelled `focus`, and the person has the wave table plus the deferred list. Follow-up questions from the runs come back through `/check-in`.

---
name: next-wave
description: Use when the person wants the next batch of tickets from a project's tracker (Jira or GitHub issues, or its board) turned into feature workspaces and started — "pull another wave", "next wave", "/next-wave", "create workspaces for the open tickets", "start the ones that are safe to run autonomously".
---

# next-wave

Turn a project's open tickets into a set of workspaces that can run **at the same time without stepping on each other**, mark each one autonomous or interactive, and start them as Claude Desktop sessions. The root session plans and starts; it never does a ticket's work itself.

No UI: don't call the werkmeister MCP tools that render the workspaces dashboard (`list-workspaces`, `status`, `open-workspaces-ui`). Everything here comes from Jira, `gh`, `git` and the `werkmeister` CLI.

## 1. Read the tickets

- Open tickets, in priority order. On a machine with `projects:` in `~/.werkmeister/config.yaml`: `werkmeister issue ready --project <name> --json`, which lists the project's board's ready column in board rank when the project has a board, else the scope's open issues (users guide § Projects). With no projects: Jira REST `search/jql` with `project=<KEY> AND statusCategory != Done ORDER BY priority DESC, rank ASC` and `fields=summary,status,priority,description,issuelinks` (credentials: the `jira:` block in `~/.werkmeister/config.yaml`). Then `werkmeister issue view <ref>` per ticket for its description and links. Read the summary and description of each; the description decides the classification below. Keep this order: it decides who goes first in step 3.
- Links: an `is blocked by` link to a ticket that isn't Done makes the ticket **Blocked**, whatever its description says.
- Already in flight: `werkmeister list-workspaces` (the CLI, a plain table of workspace, issue and labels) — any ticket that already has a workspace is not in this wave.
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

Estimate the functions each candidate changes (paths and identifiers named in the ticket, plus `git grep` for them). Compare every candidate against the others **and against tickets already in flight** (their workspaces from `werkmeister list-workspaces`). Walk the candidates in priority order. Two tickets that change the **same function** go in different waves: keep the higher-priority one (on a tie, the one that unblocks more), defer the other and say why. Different functions in the same file are allowed in one wave; note the shared file so the later PR expects a rebase. Shared test files and CHANGELOGs never count.

Show the person the wave as one table — ticket, autonomous or interactive, model, reason — plus the deferred list with a reason each. Then create without waiting unless they object.

## 4. Create the workspaces, one at a time

One `werkmeister workspace` per ticket, **in sequence** (they share source repos), in the background:

```bash
werkmeister workspace <slug> --issue-id <ref> --repos <repo> \
  [--services <only what the ticket says to run, e.g. a web app it changes>] --work-type <feature|bugfix|refactor|spike> \
  --labels focus [--autonomous] [--model sonnet]
```

- Before the first create: the code checkout the CLI runs from is on an up-to-date `main` and rebuilt (`pnpm run build` at its root; the plugin's MCP server runs `apps/werkmeister-mcp/dist`).
- List only the services the ticket says to run (usually none). The gate starts one container per touched repo and stops it (SW-34), so zero services is fine for a code change. Every listed service is a container plus an install and build on `werkmeister up`, so extra ones cost real CPU (SW-28).
- Batch check each one: the workspace dir holds `.werkmeister/issue.md` and `CLAUDE.md` has a `## Issue` section.

## 5. Start each one in Claude Desktop

`werkmeister start-args --start <workspace dir>` prints the run's `title`, `model`, `prompt` and `background` as JSON: the same ones the pane's ▶ Start work sends, with the run limits (autonomous) or the interactive line already in `prompt`. An autonomous workspace's `BRIEF.md` carries the same limits from create. Pass them to `start_session` unchanged, with `initiation: "user_asked"`, `cwd` = the workspace dir, `use_worktree: false`, `context: "fresh"`; for an interactive one, append the decisions it must ask about to `prompt`. Start them **one at a time** in one message each preceded by a bold title line; mark a chapter first when starting two or more.

Everything started carries the `focus` label (set at create, or `werkmeister init-workspace --labels focus`), so `/check-in` cycles only this wave.

## Common mistakes

| Mistake | What happens | Do instead |
|---|---|---|
| Two tickets that edit the same module in one wave | Rebases and conflicts for every later PR | Split by file overlap (step 3) |
| Creating workspaces in parallel | Worktree and slot races on the shared source repo | One `werkmeister workspace` at a time |
| Every service on every workspace | Watchers and parallel installs saturate the host (load 155 with 5 runs) | Only what the ticket says to run; stop after `pr open` |
| Starting a ticket that waits on an unmerged or unreleased one | Wasted run, or a PR built on stale main | Classify it Blocked |
| Running headless (`claude-send`) when the person asked for Desktop | Nothing in the sidebar to watch or steer | `start_session` with the workspace `cwd` |

## Stop when

Every ticket in the wave has a workspace and a started Desktop session labelled `focus`, and the person has the wave table plus the deferred list. Follow-up questions from the runs come back through `/check-in`.

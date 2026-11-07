---
name: check-in
description: Cycle through the feature workspaces from the root session, find agents waiting on a person, show each pending question as a short card, and relay the person's answer — without loading any workspace's context into the root. Use on "check in", "what's waiting on me", "cycle the workspaces", "/check-in", or "answer the agents' questions".
---

# check-in — courier pattern

The root session is the catalog. It never walks a shelf itself: for every workspace that might need a person, it sends a courier (one subagent) that reads inside the workspace and returns a fixed card. The root holds cards, not context. Answers go back through the workspace's own channel.

## 1. Triage (root, no reading inside workspaces)

Run all of these in one turn:

- `check-in` (werkmeister MCP) → one JSON sweep. Don't call `list-workspaces` or `status` here: they render the workspaces UI inline.
  - `root`: the workspaces folder; every `<root>` below means this value.
  - `workspaces[]`: the ones the label filter kept (never `skip`; only `focus` ones when any carry it), each with `labels`, `containers`, `claude` (`state`; `agent`: `working` · `needs-you` · `done` · `idle`; `question` when it asked one), `gates` (paths of `status: proposed` outputs, relative to the workspace) and `changed` (transcript moved since the last check-in). `dropped` names the rest; leave them out of everything below. Labels live in a workspace's `.werkmeister/workspace.yml` as a YAML list (`labels: [skip]`); a bare `labels: skip` reads as no labels.
  - `candidates`: the workspaces with a gate or a changed transcript (first run, `since: null`: those where Claude spoke last), never one with `claude.state: running`.
  - Each row's `lifecycle` (`working` · `ready` · `pr-open` · `merged` · `shipped` · `abandoned` · `closed-out`) and `prs[]` (`url`, `status`, `release`: the GitHub release tag that shipped it), and `readyToClose`: shipped or abandoned workspaces with no running session (SW-65). The sweep moves a merged PR to shipped itself once a release tag contains it, so a release needs no word from the person. A version-bump merge that published nothing doesn't count. Until SW-65 ships, these fields are missing: skip the close-out queue.
  - The call marks now as the last check-in, so call it once per run.
  - If the tool is missing or fails, say the werkmeister MCP is down and stop. The plugin's server is `werkmeister` (`werkmeister internal mcp`); a failed start is usually a stale build. Don't rebuild from here: tell the person to run the `install-check` skill, which brings the global install up to an up-to-date `main`, then reconnect the server.
- `list_sessions` (ccd_session_mgmt, limit 40) → map `cwd` → session title for workspaces open in the desktop app.
- `ListAgents` → which sessions have a live inbox right now:
  - a desktop title from `list_sessions` → that workspace's desktop session. A title in `list_sessions` but not in `ListAgents` is dead.
  - a row named `<ws>-<suffix>` (e.g. `sw-110-repo-dir-drift-be`) → a terminal session for that workspace. It is not in `list_sessions` but has a live inbox.
  - neither → treat the workspace as headless.

Candidates: the workspaces the person named, else `candidates` from `check-in`. If the person says "all", take every one in `workspaces[]`.

## 2. Couriers (one `Explore` subagent per candidate, all in one message)

Brief, verbatim, with `<root>` and `<ws>` filled in:

> Workspace `<root>/<ws>`. Read only: its `CLAUDE.md` (routing table), `ls stages/*/output`, the first 15 lines of each file listed by `grep -l -e "^status: proposed" -e "^status: draft" stages/*/output/*.md` (a line starting with it; the phrase quoted in instruction text is not a gate), and the werkmeister MCP tool `claude-transcript` for `<ws>` with limit 8. Do not read the code worktrees, `_shared/`, `.werkmeister/`, or stage contracts. Return exactly this card and nothing else:
>
> ```
> ## <ws> — stage <NN_name or done> — claude <idle|working>
> needs a person: yes|no
> question: <the last assistant message's ask, verbatim, ≤5 lines; or "none">
> gate: <path of the `status: proposed` or `status: draft` file, or none>
> suggested answer: <one line, or "—">
> ```
>
> "needs a person" is yes only if the last assistant message asks something, ends on a choice, or a gate file sits at `status: proposed` (a `pr-*.md` at `status: draft`).

## 3. Queue (root)

Print the cards with `needs a person: yes` first, numbered. Then a **Ready to close out** list, one line per `readyToClose` name: `<ws> — <lifecycle> — <release tag(s)> — <PR url(s)>`, plus an `abandoned` reason when there is one. A workspace can be on both lists; its card comes first. Wait for the person. Nothing else is read.

Couriers report paths relative to their workspace (`stages/...`). Before showing one, prefix it with `<ws>/` so the link resolves from the root session and opens in the file viewer: `[pr.md](<ws>/stages/04_ship/output/pr.md)`, never `[pr.md](stages/04_ship/output/pr.md)`. <!-- docs-check: ignore -->

## 4. Relay the answer

| Channel | When | How |
|---|---|---|
| the person, in that session | the session waits on an approval that no gate file holds: commit, push, merge a PR, a gated live run (feature up/stop/down, a real push), a repo setting or ruleset, deleting files outside the workspace; or it waits on a post-mortem answer (the skill takes those only from the person); or it has an open question box (AskUserQuestion) that is not a gate file's human check; or it already turned down a relayed answer (SW-301) | Never send a "yes" or a decision on the person's behalf: a session can't take a peer message as the person's approval, so it asks again and the person answers twice. Tell the person what to type and where, as a line they can paste: "read `<ws>/…/pr.md`, then type `go` in `<session>`", linking a desktop session as `[title](#<sessionId>)`, and point to the workspace's card in the /workspaces pane (Switch or Jump) to get there. Facts the session lacks (a PR merged, a release shipped) can still go through the channels below, labelled "context, not an approval". | <!-- docs-check: ignore -->
| live session | a desktop title or `<ws>-<suffix>` terminal row for the workspace is in `ListAgents` | Note the time, then `SendMessage` to that name (append its `[ref]` only if two rows share it) with `notify_when_idle: true`. The turn runs in their session, and one idle notice comes back here when it finishes. A send that succeeds and an idle notice prove nothing (a hook can drop the prompt, and the notice then quotes the session's answer from before the send): when the notice arrives, call `relay-check` (werkmeister MCP) with the workspace, the time you noted and the message text. `pickedUp: false` → report its `hint` (`not picked up: type <text> in <session>`), name the session row, and stop there: no second send, and no headless fallback while a live session holds the workspace. |
| headless | no live session, and the answer needs no new permissions (a decision, a fact, "continue") | `claude-send` (werkmeister MCP) with the answer; later `claude-turn-status` to see it finished. A headless turn cannot show a permission prompt: anything it is not already allowed to do fails silently into a "run this yourself" reply. |
| interactive terminal | no live session, and the answer leads to commands (tests, git, gh, builds) | `claude-resume` (werkmeister MCP) opens the session in a VS Code integrated terminal when this session runs in VS Code (`TERM_PROGRAM=vscode`, or `WERKMEISTER_LAUNCHER=vscode`), otherwise a Terminal.app window; its reply says which. Pass the answer as `prompt` so it is the first message; the person approves prompts as they come. |
| close out | the person says yes to one or more `readyToClose` names (never without that yes; it deletes the folder and the merged branches) | `close-out` (werkmeister MCP) per workspace, one at a time; the plugin archives its desktop sessions. Report each one's result, and any terminal session it lists for the person to `/exit`. |
| gate file | the answer approves a gate file: an `output/*.md` at `status: proposed`, or a `pr-*.md` at `status: draft` ("approve", "proceed", "continue", "open it") | edit that line to `status: decided (approved via check-in YYYY-MM-DD)` (a PR file: `status: approved  # approved via check-in YYYY-MM-DD`), plus any corrections the person gave, then send "gate decided, continue: re-read `<rel>`" through the live session or headless channel above. The note is how the waiting session tells this relay from a peer's (SW-455): without it, it refuses. Don't claim the approval in the message ("Jay approved …"); the file carries it. If that session holds the gate's human check in an open question box (SW-517), the send waits behind it: tell the person to dismiss the box there (Esc), not to answer it, since the file already holds the answer. |

A message from here cannot approve a permission prompt in the other session, and a session in bypass mode holds it for the person's approval. So an "approve" is always the gate-file edit, never a chat message. Only this skill and the /workspaces pane change another workspace's gate file, and only on the person's answer in this turn; no other root task (triage, next-wave, a courier) edits a workspace's `stages/*/output`.

Never send to a workspace whose `claude.state` is `running`. Never paste a card's question back into this session as context; the card is the context.

## Stop when

Every card marked `needs a person: yes` has an answer relayed and every `readyToClose` workspace is closed out or left by the person's choice, or the person says stop. Live-session relays report back by idle notice; when one arrives, run `relay-check` first, then re-run step 2 for that workspace only when it was picked up. Headless relays have no notice: re-run `/check-in` later, step 1 is cheap.

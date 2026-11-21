---
"werkmeister": minor
"werkmeister-core": minor
---

A `stage.done` metrics event (SW-777), with the stage and the record-branch commit that first filled its `output/`, timed at that commit. The agent-state hook writes it after the tool call that follows the commit, and close-out writes any it missed; a claim file per stage under `.werkmeister/stage-done/` keeps it to one per stage, also across parallel tool calls; `usage.json` counts an event only when its commit is in the workspace's history, so a reused workspace name does not pick up an earlier run's times. `usage.json` stage minutes now come from these events, or from that commit when there is no event, and the oldest output mtime only when the stage has no commit. A stage never counts negative minutes, and two stages committed together no longer get split by their files' mtimes.

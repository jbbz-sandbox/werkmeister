---
name: starting-prompt
description: "Run the `starting_prompt` defined in the sandbox workspace's `.werkmeister/workspace.yml`. Use when the user says '/werkmeister:starting-prompt', 'run the starting prompt', 'run my workspace starting prompt', 'kick off the workspace task', or asks to execute the task this sandbox workspace was created for."
---

# Sandbox Starting Prompt

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

Read the `starting_prompt` from the current sandbox workspace's `.werkmeister/workspace.yml` and execute it as the task to perform.

## Step 1 — Extract the starting prompt

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/starting-prompt/scripts/get_prompt.py"
```

The script walks up from the current directory to find `.werkmeister/workspace.yml` and prints the `starting_prompt` value to stdout.

Exit codes:

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Prompt printed to stdout | Proceed to Step 2 |
| 1 | No `.werkmeister/workspace.yml` found | Tell the user no sandbox workspace was found from the current directory; stop |
| 2 | File found but `starting_prompt` is empty | Tell the user the workspace has no starting prompt set; stop |

If invoked from outside the workspace root, pass `--start <workspace-dir>`.

## Step 2 — Execute the prompt

Treat the printed text as the user's instruction and carry it out as a normal task. Begin work immediately:

- Honor any in-task checklists / numbered verification steps in the prompt.
- Follow the workspace's CLAUDE.md conventions and routing rules while doing the work.
- If the prompt has unmet preconditions (e.g. "after confirming X is resolved"), verify or surface them before taking irreversible actions.

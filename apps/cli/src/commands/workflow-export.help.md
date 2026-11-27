## Description

Writes an ICM workspace's stages as a workflow folder: `workflow.yaml` and one `stages/<name>.md` per stage, read from the workspace's `stages/NN_<name>/CONTEXT.md`, the root `CONTEXT.md` and `AGENTS.md`. It drops what werkmeister adds to each contract (the `## Pre-approved` section, step `0.`, the ask-tool line and the standards line) and turns this workspace's stage paths, worktrees and reload line back into the workflow variables `at:<stage>`, `repos` and `restart` (each written in double braces). Hand edits to the contracts are kept.

`<workspace>` is a workspace name, as `werkmeister workspace list` prints it, or a path (`.` or anything with a `/`). It refuses a workspace that isn't icm, or a `--to` folder that exists and isn't empty. Before it finishes, it loads the folder as `workspace init` would, and removes what it wrote if that fails.

An autonomous workspace never rendered its human checks, so each exported stage uses its self-check as the human check, and the command warns.

Put the folder at `~/.werkmeister/workflows/<type>/` or `<repo>/.werkmeister/workflows/<type>/` to use it: see "Adding your own workflow" in `docs/icm-workflows.md`. A repo's workflow may not grant `workspace serve:*` or `pr autosquash:*`; the command warns when the export carries them.

## Examples

```bash
werkmeister workflow export sw-1079-workflow-export --to ~/.werkmeister/workflows/review
werkmeister workflow export . --to ../review-workflow
```

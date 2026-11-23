---
"werkmeister": minor
---

`werkmeister workflow export <workspace> --to <dir>` writes an icm workspace's stages as a workflow folder (`workflow.yaml` and `stages/<name>.md`) that loads back into the same contracts, hand edits kept. A workflow in `~/.werkmeister/workflows/` may now also grant `pr autosquash:*` and `workspace serve:*`, the built-ins' other two grants, so an exported built-in loads there; a repo's workflow still may not. See "Turn it into a template" in `docs/icm-workflows.md`.

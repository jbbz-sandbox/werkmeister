---
"werkmeister-core": patch
"werkmeister": patch
"werkmeister-mcp": patch
---

SW-463: a `pr watch` wake held for an open but idle Claude session now reaches it without anyone typing. Workspace status rows list `heldWakes` (the sessions with a `wake-nudge-<id>.json`), and the werkmeister plugin's band submits one short prompt when its own session has one, no turn is running and Desktop's wrap_up box isn't waiting. The prompt's UserPromptSubmit hook then delivers and claims the wake as before.

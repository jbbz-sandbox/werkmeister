---
"werkmeister": minor
---

SW-195: `claude-resume` and `pr-reconcile` open a VS Code integrated terminal when the caller runs in VS Code (`TERM_PROGRAM=vscode`, or `WERKMEISTER_LAUNCHER=vscode|terminal` to force either), through the extension's new `vscode://jbbz.werkmeister-vscode/claude?workspace=…&mode=…&session=…&prompt=…` URI handler; Terminal.app elsewhere, as before. `claude-resume` takes an optional `prompt` sent as the session's first message, and both tools report which `launcher` opened.

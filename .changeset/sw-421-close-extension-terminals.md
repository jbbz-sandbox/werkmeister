---
"werkmeister-vscode": patch
"werkmeister-core": patch
---

SW-421: when a workspace closes out (from the CLI, MCP or the pane), the VS Code extension closes the terminals it opened there within about 3 s of close-out finishing, and frees their pool slots. That covers the `claude <ws>` sessions, including the one that ran the close-out, and the pooled `werkmeister <ws>` ones. It shows a message naming the sessions it closed. A terminal you opened by hand is never touched, and a session whose folder was only moved stays open. Close-out's `/exit it` lines no longer list the sessions the extension closes, and still list every other terminal session in the folder.

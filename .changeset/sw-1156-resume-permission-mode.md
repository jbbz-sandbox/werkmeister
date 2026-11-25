---
"werkmeister": patch
---

SW-1156: resuming a paused workspace whose Claude session ran in auto mode continues it headless in auto mode, instead of `acceptEdits`, which refused the git and `werkmeister` commands auto mode had approved. With nobody watching that turn, it also gets the deny rules unattended runs get (no daemon, infra or machine commands, no `docker rm`). A session in any other mode, or with no recorded mode, is no longer continued headless: "continue" waits for the session to be opened, and resume prints `its last mode was <mode>; a headless turn can't ask for approval, so open the session to continue (claude --resume <id>)`. `claude-send` to an auto-mode session also keeps auto mode.

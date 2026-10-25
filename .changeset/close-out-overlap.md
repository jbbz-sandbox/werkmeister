---
"werkmeister-core": patch
"werkmeister": patch
---

SW-90: `close-out` is safe when two runs overlap. `closeOut` takes a per-workspace lock, so a second run says "close-out of '<name>' is already running" right away. A run that finds the folder already gone, at the start or by the `closeout.md` write, says the workspace is already closed out instead of throwing ENOENT. `sandbox close-out` without `--yes` and without a terminal refuses at once ("needs --yes when not run from a terminal"). Before, it read an empty stdin and exited 130 after the prompt with no message. Any no-TTY prompt that runs out of input now says so before it exits.

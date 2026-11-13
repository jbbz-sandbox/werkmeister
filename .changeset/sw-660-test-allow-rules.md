---
"werkmeister-core": patch
"werkmeister": patch
---

SW-660: a workspace's allow rules now cover the test command exactly as werkmeister-context.md prints it, the repo's appended lint included. A test command of more than one command (an `&&` chain, a `{ …; }` group, `||`, `;`, a pipe) is printed and allowed as one exact `with-temp-home sh -c '…'` line, so every part runs under the temp HOME and the `{ …; }` rows are no longer a shell syntax error; the bare per-segment rules for the wrapped form are gone. One simple command keeps its `with-temp-home <cmd>:*` rule. `validate:` text still gets no rule. Existing workspaces pick the rules up on refresh or `werkmeister machine migrate`, and the headless wake passes the same list.

## Description

`context` prints the workspace's notes context for a fresh Claude Code window. It is the SessionStart hook's target: it reads the hook's payload on stdin, never fails, and always exits 0.

`graduate` scaffolds an open `decision` note into the standards tree. At a terminal it asks for the domain and kind; otherwise pass `--domain` and `--kind`.

## Examples

```bash
werkmeister notes context
werkmeister notes graduate 3 --domain testing --kind rule
```

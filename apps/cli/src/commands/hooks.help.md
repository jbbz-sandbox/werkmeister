## Description

The Claude Code hook entry points: `gate` (PreToolUse, per edit), `pr-guard` (blocks `gh pr create` inside a workspace) and `agent-state` (records the session's state on every tool call). The hooks a workspace installs call them; the `werkmeister` wrapper runs the same modules directly on a fast path. Run them by hand only to debug a hook.

## Examples

```bash
werkmeister hooks gate
```

---
"werkmeister": patch
"werkmeister-core": patch
"werkmeister-mcp": patch
---

SW-270: `werkmeister workspace close --no-pr "<reason>"` (MCP `close-out` `no_pr`) closes a workspace whose work changed no repo as done, not abandoned. It needs no PR files, `postmortem.md`, and every code worktree clean with no commits ahead of its base, and refuses with the failing repo named otherwise. The issue moves to Done with `No PR needed: <reason>`, which goes in `closeout.md` too. A no-PR workspace closed without the flag now hears about `--no-pr` beside `workspace abandon`.

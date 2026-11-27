---
"werkmeister-core": minor
"werkmeister": minor
---

SW-1231: claude workspaces now keep their instructions in `AGENTS.md`, like every other harness, and `CLAUDE.md` becomes the one line `@AGENTS.md`. Claude Code loads that import on every version, even under a folder that has its own `CLAUDE.md`, which turns off Claude Code's native `AGENTS.md` fallback. Re-run `werkmeister workspace init` in a workspace to migrate it. Its old `## Handoff Notes` are kept as a note.

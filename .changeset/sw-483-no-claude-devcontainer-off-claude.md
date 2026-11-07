---
"werkmeister-core": patch
"werkmeister": patch
---

SW-483: `workspace init` writes `.devcontainer/devcontainer.json` only on a `harness: claude` workspace. On `mcp`, `codex` and `opencode` it writes none (the generated one installs and registers Claude Code only) and removes one it generated before; a hand-written file is kept.

---
"werkmeister": minor
---

SW-637: `machine setup` (and `--check`) now checks its prerequisites first: a harness (`claude`, `opencode` or `codex`), git, Node.js 22 or later, and Docker with Compose v2. On a miss it stops before the first question, writes nothing, names what's missing and how to install it, and exits 1. A missing `docker` and a daemon that can't be reached get different messages. Without `claude` on PATH, the plugin step is now skipped with a note (⚠) instead of failing setup.

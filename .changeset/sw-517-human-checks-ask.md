---
"werkmeister-core": minor
---

SW-517: every ICM stage's human check now asks through the harness's question tool, named by the new `HarnessLayout.questionTool`: `AskUserQuestion` on Claude Code, `question` on OpenCode. It asks at most 4 questions per call, in batches when there are more, each standing on its own, and the recommended option first. On `codex` and `mcp`, which have no such tool, it asks one numbered block at the end of the reply. The answer goes into the stage's output as its status, noted `(approved in chat YYYY-MM-DD)`. Autonomous self-checks are unchanged. Reaches a workspace at its next `workspace init`.

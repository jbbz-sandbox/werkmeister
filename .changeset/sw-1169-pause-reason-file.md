---
"werkmeister": patch
---

SW-1169: the pause gate's refusal names the file it read (`<workspace>/.werkmeister/paused.json`), says the pause ends when that file is gone, and tells the agent to retry one command after Resume or a message from the person before reporting the workspace as paused. A session reopened from before Resume had read the old refusal as current and stopped without trying.

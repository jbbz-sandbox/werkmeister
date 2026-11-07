---
"werkmeister": patch
---

SW-545: while a session's own service start waits for capacity (the pr gate's starts, `feature up --service`), the hook no longer blocks the person's prompts or the session's tool calls. The prompt goes through with context naming the queue position, the services and how to stop the wait. A whole-feature queue still holds the session as before.

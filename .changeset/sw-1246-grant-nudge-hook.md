---
"werkmeister-core": patch
"werkmeister": patch
---

SW-1246: a capacity grant's "continue" (`Capacity freed: … Continue where you left off.`) now reaches a session that was mid-turn when it landed, such as one waiting on its own question: in Claude Code the session hook adds it as context to the question's answer or to the next prompt, instead of deleting it as stale on that prompt. OpenCode's hook passes no context back, so there it is still lost, as before. A grant 21 s into an open question had left a CLI session idle for 5.5 h over a feature that was already up.

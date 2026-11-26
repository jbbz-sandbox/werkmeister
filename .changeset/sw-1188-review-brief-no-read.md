---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1188: the ICM review brief now also tells the review subagent never to read, list or write the real `~/.werkmeister`, the host daemon or another workspace. Anything it needs from them, it asks for or reproduces under a temp HOME. Before, the brief only made writes a Must fix.

---
"werkmeister-core": patch
"werkmeister": patch
---

SW-235: an autonomous workspace's BRIEF.md no longer tells the agent to ask the user about its open questions. `## Open questions` drops the "Ask / Confirm with the user …" sentences that follow each question, and says to decide each one per the run limits and record the choice under `## Recommendations for reviewer`. Interactive briefs are unchanged.

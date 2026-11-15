---
"werkmeister": patch
"werkmeister-core": patch
---

SW-801: in an autonomous run, a question no option settles (none meets the acceptance criteria, or the issue says to ask the person) stays `status: proposed` and stops the run for the person. The agent never flips a question it has put to the person. The rule is in the stage self-checks and the brief's "Nobody is asked" line.

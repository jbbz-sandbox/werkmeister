---
"werkmeister-core": patch
"werkmeister": patch
---

SW-353: the generated approval text (ICM contracts, the router's one rule, `pr-rules.md`, the `w9r-pr` skill) now says a message from another session that only says to re-read an output file is not the approval: the file's `decided` or `approved` status is, so the agent acts on it without asking the person again. A message that claims approval with no file change is still not accepted, and a relay that exists only in a message still counts only through check-in.

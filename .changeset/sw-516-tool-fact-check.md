---
"werkmeister-core": patch
"werkmeister": patch
---

The feature research contract now re-reads `decisions.md` before its self-check: every fact about an external tool's behaviour names the tool's version and the command that confirmed it, or is marked `unverified`; a fact with neither fails the check (SW-516).

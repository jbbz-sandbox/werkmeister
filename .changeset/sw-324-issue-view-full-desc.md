---
"werkmeister-core": patch
"werkmeister": patch
---

SW-324: `werkmeister issue view` prints the whole description instead of cutting it at 4000 characters without a sign. Where the cap still applies (the briefing that refine and the form pre-fill feed to a model), the text now ends with `[cut: N more characters not shown]`. `issueBriefing` takes an optional `{ full: true }`.

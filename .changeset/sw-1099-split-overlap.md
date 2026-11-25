---
"werkmeister": patch
---

SW-1099 follow-up: on the dashboard's Metrics tab, a stage's waiting/working bar and its "% waiting" no longer overstate waits when a person wait and a capacity wait overlap. The bar now sums to the stage's time, and each minute waited counts once. A slowest ticket with no release time reads "to merge".

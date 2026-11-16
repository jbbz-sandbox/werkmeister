---
"werkmeister-core": patch
---

SW-774: close-out's `usage.json` and `usage.md` no longer show negative stage minutes. A stage now ends at the earlier of the record-branch commit that first added a file to its `output/` (`.gitkeep` excluded) and its oldest output file, so stages committed together keep their own times. Before, it ended at its newest output file, so a later edit to an earlier stage made the next stage's duration negative.
